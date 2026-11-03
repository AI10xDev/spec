import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


SOURCE = Path(__file__).with_name("performance-session.py")
module = importlib.util.spec_from_file_location("performance_session", SOURCE)
runner = importlib.util.module_from_spec(module)
module.loader.exec_module(runner)


class PerformanceSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / "project with spaces"
        self.project.mkdir()
        self.directory = self.root / "run"
        self.directory.mkdir(mode=0o700)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.cli = self.bin / "opencode-source"
        self.cli.write_text("""#!/usr/bin/python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ['TEST_ROOT'])
root.joinpath('captured.json').write_text(json.dumps({
    'argv': sys.argv[1:], 'prompt': sys.stdin.read(), 'cwd': os.getcwd(),
    'env': {k:v for k,v in os.environ.items() if k.startswith(('SPEC_', 'KIBI_', 'OPENCODE_'))}}))
for line in json.loads(os.environ.get('TEST_EVENTS', '[]')):
    print(json.dumps(line), flush=True)
sys.exit(int(os.environ.get('TEST_EXIT', '0')))
""")
        self.cli.chmod(0o700)
        self.env = dict(os.environ, PATH=f"{self.bin}:/usr/bin:/bin", TEST_ROOT=str(self.root),
                        TEST_EVENTS=json.dumps([{"type": "text", "sessionID": "ses_Fresh123",
                                               "part": {"text": "real mock output"}}]))
        for key in ("SPEC_EXECUTION_PROFILE", "SPEC_EXECUTION_API_KEY", "OPENCODE_CONFIG_CONTENT"):
            self.env.pop(key, None)

    def execute(self, request=None):
        path = self.directory / "performance-request.json"
        path.write_text(json.dumps(request if request is not None else
                                  {"project": self.project.name, "spec": None}))
        path.chmod(0o600)
        return subprocess.run([sys.executable, "-I", str(SOURCE), str(self.directory),
                               str(self.root), str(path)], env=self.env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)

    def test_project_validation(self):
        for value in ("", " ", "../outside", "project with spaces/..", "missing", "bad\npath", None):
            with self.subTest(value=value), self.assertRaises((ValueError, OSError)):
                runner.configuration(self.root, {"project": value, "spec": None})
        (self.root / "file").touch()
        with self.assertRaises(ValueError):
            runner.configuration(self.root, {"project": "file", "spec": None})
        with tempfile.TemporaryDirectory() as outside:
            (self.root / "escape").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "escapes"):
                runner.configuration(self.root, {"project": "escape", "spec": None})
            self.assertEqual(runner.configuration(self.root, {"project": outside, "spec": None}), Path(outside))
        for upload in ({}, {"name": "x", "content": 1}, {"name": "\n", "content": "text"}):
            with self.assertRaises(ValueError):
                runner.configuration(self.root, {"project": self.project.name, "spec": upload})

    def test_fresh_builder_prompt_and_inherited_spec_cleanup(self):
        self.env.update(SPEC_SESSION_DIR="old", KIBI_SPEC_SESSION="old", SPEC_BUILD_FOREGROUND="1",
                        SPEC_OPTIM_CONFIG="old", OPENCODE_SESSION_ID="ses_Old",
                        OPENCODE_CONFIG_CONTENT=json.dumps({"instructions": ["AGENTS.md", "/old/.spec-runs/run-x/instructions.md"],
                            "plugin": ["keep-plugin", "/old/spec-build-session.xyz.mjs"]}))
        upload = {"name": "experiment.md", "content": "Use supplied evaluator and datasets.\n"}
        result = self.execute({"project": self.project.name, "spec": upload})
        self.assertEqual(result.returncode, 0, result.stderr)
        captured = json.loads((self.root / "captured.json").read_text())
        self.assertEqual(captured["argv"], ["run", "--dir", str(self.project), "--agent", "build", "--format", "json"])
        self.assertEqual(captured["cwd"], str(self.project))
        for phrase in ("gemma4-policy", "not the distillation", "performance.json", "Do not implement or rebuild",
                       "prior spec logs/session", "--train-data", "--validation-data", "--sol-command",
                       "synthetic/toy/simulator fallback", "actionable missing", "validation.json", "experiment.md"):
            self.assertIn(phrase, captured["prompt"])
        for key in ("SPEC_SESSION_DIR", "KIBI_SPEC_SESSION", "SPEC_BUILD_FOREGROUND", "SPEC_OPTIM_CONFIG", "OPENCODE_SESSION_ID"):
            self.assertNotIn(key, captured["env"])
        config = json.loads(captured["env"]["OPENCODE_CONFIG_CONTENT"])
        self.assertEqual(config, {"instructions": ["AGENTS.md"], "plugin": ["keep-plugin"]})
        session = self.directory / "session-id"
        self.assertEqual(session.read_text(), "ses_Fresh123\n")
        self.assertEqual(session.stat().st_mode & 0o777, 0o600)
        self.assertIn(b"real mock output", result.stdout)
        result = self.execute()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"fresh session", result.stderr)

    def test_fallback_cli_and_session_created_event(self):
        self.cli.rename(self.bin / "opencode")
        self.env["TEST_EVENTS"] = json.dumps([{"type": "session.created", "properties": {"info": {"id": "ses_New"}}}])
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.directory / "session-id").read_text(), "ses_New\n")

    def test_agent_errors_and_bad_identity_fail(self):
        for events, code, message in (
            ([{"type": "error", "sessionID": "ses_Error", "error": {"message": "denied"}}], "0", b"agent error"),
            ([{"type": "text", "sessionID": "ses_Exit"}], "7", b"exit status 7"),
            ([], "0", b"no valid session ID"),
            ([{"sessionID": "ses_bad/path"}], "0", b"Invalid OpenCode session ID"),
            ([{"sessionID": "ses_" + "a" * 124}], "0", b"Invalid OpenCode session ID"),
            ([{"sessionID": "ses_First"}, {"sessionID": "ses_Second"}], "0", b"identity changed"),
        ):
            with self.subTest(message=message):
                for name in ("session-id", "performance-prompt.txt"):
                    (self.directory / name).unlink(missing_ok=True)
                self.env.update(TEST_EVENTS=json.dumps(events), TEST_EXIT=code)
                result = self.execute()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_bounded_event_lines_and_large_prompt(self):
        self.cli.write_text("#!/usr/bin/python3\nprint('x' * (1024 * 1024 + 1), flush=True)\n")
        result = self.execute({"project": self.project.name, "spec": {"name": "large", "content": "x" * 200000}})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"event line exceeds", result.stderr)
        self.assertLess(len(result.stdout), 1024 * 1024)

    def test_saved_provider_is_applied_without_printing_credentials(self):
        profile = self.directory / "execution-profile.json"
        profile.write_text(json.dumps({"provider": "openai", "model": "chosen", "endpoint": "https://example.test/v1",
                                      "apiVersion": "", "apiKey": "private-test-key"}))
        profile.chmod(0o600)
        (self.directory / "provider-setup.bash").write_bytes(SOURCE.with_name("remote-provider.bash").read_bytes())
        self.env["SPEC_EXECUTION_PROFILE"] = str(profile)
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        captured = json.loads((self.root / "captured.json").read_text())
        self.assertEqual(captured["argv"][-2:], ["--model", "spec-execution/chosen"])
        self.assertEqual(captured["env"]["SPEC_EXECUTION_API_KEY"], "private-test-key")
        self.assertNotIn("private-test-key", captured["env"]["OPENCODE_CONFIG_CONTENT"])
        self.assertNotIn(b"private-test-key", result.stdout + result.stderr)

    def test_unsafe_and_malformed_requests_never_launch_builder(self):
        path = self.directory / "performance-request.json"
        for kind in ("public", "symlink", "hardlink", "fifo", "oversized", "duplicate"):
            with self.subTest(kind=kind):
                path.unlink(missing_ok=True)
                content = json.dumps({"project": self.project.name, "spec": None})
                if kind in ("symlink", "hardlink"):
                    target = self.root / f"{kind}-request"
                    target.write_text(content)
                    target.chmod(0o600)
                    if kind == "symlink":
                        path.symlink_to(target)
                    else:
                        os.link(target, path)
                elif kind == "fifo":
                    os.mkfifo(path, 0o600)
                else:
                    if kind == "oversized":
                        content = " " * (runner.LIMIT + 1)
                    elif kind == "duplicate":
                        content = '{"project":".","project":"other","spec":null}'
                    path.write_text(content)
                    path.chmod(0o644 if kind == "public" else 0o600)
                result = subprocess.run([sys.executable, "-I", str(SOURCE), str(self.directory),
                                         str(self.root), str(path)], env=self.env,
                                        capture_output=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / "captured.json").exists())
                self.assertFalse((self.directory / "session-id").exists())
                self.assertFalse((self.directory / "performance-prompt.txt").exists())

    def test_invalid_provider_fails_without_fallback_or_secret_disclosure(self):
        profile = self.directory / "execution-profile.json"
        profile.write_text(json.dumps({"provider": "invalid", "model": "chosen", "endpoint": "",
                                      "apiVersion": "", "apiKey": "private-test-key"}))
        profile.chmod(0o600)
        (self.directory / "provider-setup.bash").write_bytes(SOURCE.with_name("remote-provider.bash").read_bytes())
        self.env["SPEC_EXECUTION_PROFILE"] = str(profile)
        result = self.execute()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"refusing fallback", result.stderr)
        self.assertNotIn(b"private-test-key", result.stdout + result.stderr)
        self.assertFalse((self.root / "captured.json").exists())

    def test_remote_transport_detach_private_upload_and_scoped_cancellation(self):
        self.env["HOME"] = str(self.root)
        (self.root / ".bash_aliases").write_text("exit 99\n")
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        spec_registry = self.root / ".git/spec-harness"
        spec_registry.mkdir(mode=0o700)
        (self.root / ".spec-runs").mkdir(mode=0o700)
        self.cli.write_text("""#!/usr/bin/python3
import json, os, pathlib, subprocess, time
child = subprocess.Popen(['sleep', '60'])
pathlib.Path(os.environ['TEST_ROOT'], 'started').write_text(str(child.pid))
print(json.dumps({'type':'text','sessionID':'ses_Transport','part':{'text':'mock metrics'}}), flush=True)
time.sleep(60)
""")
        source = SOURCE.parent
        script = (source / "remote-build.bash").read_text().replace(".spec-runs", ".performance-runs")
        recovery = (source / "remote-recover.bash").read_text().replace(".spec-runs", ".performance-runs")
        payload = SOURCE.read_bytes()
        request = json.dumps({"project": self.project.name, "spec": None}).encode()
        identity = str(uuid.uuid4())
        directory = self.root / ".performance-runs" / f"run-{identity}"
        process = subprocess.Popen(["bash", "-c", script, "--", str(self.root), str(len(payload)),
            (source / "remote-alias.bash").read_text(), (source / "remote-supervisor.bash").read_text(),
            identity, "test.md", "performance", "", "", str(len(request)), "0", ""],
            env=self.env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            process.stdin.write(payload + request)
            process.stdin.flush()
            deadline = time.monotonic() + 10
            while not (self.root / "started").exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue((self.root / "started").exists())
            self.assertEqual((directory / "performance-request.json").read_bytes(), request)
            self.assertEqual((directory / "performance-request.json").stat().st_mode & 0o777, 0o600)
            self.assertFalse((self.root / "projects").exists())
            self.assertTrue((spec_registry / f"run-{identity}").exists())
            process.stdin.close()
            process.wait(timeout=5)
            result = subprocess.run(["bash", "-c", recovery, "--", str(self.root), identity, "snapshot", "test.md"],
                                    capture_output=True, env=self.env, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(result.stdout.startswith(b"SPEC-RUN-1 running "), result.stdout)
        finally:
            subprocess.run(["bash", "-c", recovery, "--", str(self.root), identity, "cancel", "test.md"],
                           capture_output=True, env=self.env, timeout=10)
            if not process.stdin.closed:
                process.stdin.close()
            process.wait(timeout=5)
        deadline = time.monotonic() + 10
        while not (directory / "status").exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual((directory / "status").read_text(), "130\n")
        self.assertEqual((directory / "session-id").read_text(), "ses_Transport\n")
        self.assertEqual(list((self.root / ".spec-runs").iterdir()), [])
        self.assertFalse((spec_registry / f"run-{identity}").exists())
        pid = (self.root / "started").read_text()
        state = Path(f"/proc/{pid}/stat")
        if state.exists():
            self.assertEqual(state.read_text().split()[2], "Z")


if __name__ == "__main__":
    unittest.main()
