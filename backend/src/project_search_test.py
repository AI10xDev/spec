import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).with_name("project-search.py")
SPEC = importlib.util.spec_from_file_location("project_search", SOURCE)
search = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(search)

STUB = r'''#!/usr/bin/env python3
import json, os, signal, subprocess, sys, time
from pathlib import Path
prompt = sys.stdin.read()
payload = json.loads(prompt.splitlines()[-1])
config = json.loads(os.environ["OPENCODE_CONFIG_CONTENT"])
capture = {"argv": sys.argv[1:], "cwd": os.getcwd(), "prompt": prompt,
           "config": config, "env": {k: v for k, v in os.environ.items()
           if k.startswith(("OPENCODE_", "SPEC_EXECUTION_"))}}
Path(os.environ["CAPTURE"]).write_text(json.dumps(capture))
mode = os.environ.get("STUB_MODE", "ok")
paths = payload["inventory"][:20]
if mode == "exit":
    print("SECRET PROVIDER LOG", file=sys.stderr)
    sys.exit(7)
if mode == "overflow":
    sys.stdout.write("x" * 262145)
    sys.exit(0)
if mode == "stderr_overflow":
    sys.stderr.write("x" * 262145)
    sys.exit(0)
if mode == "timeout":
    child = subprocess.Popen([sys.executable, "-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)"])
    Path(os.environ["CHILD_PID"]).write_text(str(child.pid))
    time.sleep(120)
if mode == "raw":
    print(json.dumps({"paths": paths}))
    sys.exit(0)
if mode == "stale":
    Path(paths[0]).rmdir()
if mode == "symlink":
    Path(paths[0]).rmdir()
    Path(paths[0]).symlink_to(os.environ["OUTSIDE"], target_is_directory=True)
if mode == "invented": paths = [str(Path(paths[0]).parent / "project-invented")]
if mode == "duplicate": paths = paths + paths[:1]
if mode == "too_many": paths = payload["inventory"][:21]
if mode == "error":
    print(json.dumps({"type": "error", "error": {"data": {"message": "SECRET PROVIDER LOG"}}}))
if mode in ("tool_call", "tool_use"):
    print(json.dumps({"type": mode, "part": {"type": "tool", "tool": "bash"}}))
print(json.dumps({"type": "step_start", "timestamp": 123, "sessionID": "ses_test",
                  "part": {"id": "prt_start", "sessionID": "ses_test", "messageID": "msg_test", "type": "step-start"}}))
text = json.dumps({"paths": paths})
if mode == "markdown": text = "```json\n" + text + "\n```"
if mode == "nonfinite": text = '{"paths": [], "number": NaN}'
if mode == "malformed": text = '{"paths":'
if mode == "empty": text = ""
print(json.dumps({"type": "text", "timestamp": 124, "sessionID": "ses_test",
                  "part": {"id": "prt_text", "sessionID": "ses_test", "messageID": "msg_test",
                           "type": "text", "text": text, "time": {"start": 123, "end": 124}}}))
print(json.dumps({"type": "step_finish", "timestamp": 125, "sessionID": "ses_test",
                  "part": {"id": "prt_finish", "sessionID": "ses_test", "messageID": "msg_test",
                           "type": "step-finish", "reason": "stop", "cost": 0,
                           "tokens": {"input": 42, "output": 7, "reasoning": 0, "cache": {"read": 0, "write": 0}}}}))
'''


class ProjectSearchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="project-search-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "root"
        self.workspace = self.root / "workspace"
        self.workspace.mkdir(parents=True)
        self.engine = self.base / "opencode stub"
        self.engine.write_text(STUB)
        self.engine.chmod(0o700)
        self.capture = self.base / "capture.json"
        self.pid = self.base / "pid"
        self.outside = self.base / "outside"
        self.outside.mkdir()
        self.env = patch.dict(os.environ, {"SPEC_PROJECT_SEARCH_OPENCODE": str(self.engine),
                                          "CAPTURE": str(self.capture), "CHILD_PID": str(self.pid),
                                          "OUTSIDE": str(self.outside), "STUB_MODE": "ok"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def folder(self, name):
        path = self.root / name
        path.mkdir(parents=True)
        return path

    def payload(self, query="project", profile=None, provider_script=""):
        return json.dumps({"query": query, "profile": profile, "provider_script": provider_script}).encode()

    def run_search(self, query="project", **kwargs):
        return search.search(self.workspace, self.payload(query, **kwargs))

    def cli(self, payload=None, source=None):
        return subprocess.run([sys.executable, "-I", "-B", "-c", source or SOURCE.read_text(), str(self.workspace)],
                              input=self.payload() if payload is None else payload,
                              capture_output=True, timeout=5)

    def test_inventory_siblings_depth_and_ignored_entries(self):
        good = [self.folder("Project Z"), self.folder("group/project-a"), self.folder("group/deep/project-b")]
        self.folder("group/deep/too-deep/project-hidden")
        for skip in (".hidden", "node_modules", "vendor", "target", "__pycache__", "dist", "build", "venv"):
            self.folder(skip + "/project-skipped")
        (self.root / "project-file").write_text("not read")
        (self.root / "project-link").symlink_to(self.outside, target_is_directory=True)
        root, paths, truncated = search.inventory(self.workspace, "PROJECT")
        self.assertEqual(root, self.root)
        self.assertEqual(paths, sorted(map(str, good), key=lambda path: (Path(path).name.casefold(), path)))
        self.assertFalse(truncated)

    def test_inventory_does_not_read_file_contents(self):
        self.folder("project")
        with patch("builtins.open", side_effect=AssertionError("file read")), patch.object(Path, "open", side_effect=AssertionError("file read")):
            self.assertEqual(len(search.inventory(self.workspace, "project")[1]), 1)

    def test_workspace_included(self):
        result = self.run_search(" WORKSPACE ")
        self.assertEqual(result["projects"], [{"name": "workspace", "path": str(self.workspace)}])

    def test_candidate_and_result_caps(self):
        for index in reversed(range(45)):
            self.folder(f"project-{index:02}")
        root, candidates, truncated = search.inventory(self.workspace, "project")
        self.assertEqual(candidates, [str(root / f"project-{index:02}") for index in range(40)])
        self.assertTrue(truncated)
        result = self.run_search()
        self.assertEqual(len(result["projects"]), 20)
        self.assertTrue(result["truncated"])

    def test_scan_budget_discards_partial_directory_deterministically(self):
        for index in reversed(range(11)):
            self.folder(f"project-{index:02}")
        with patch.object(search, "ENTRY_LIMIT", 10):
            first = search.inventory(self.workspace, "project")
            second = search.inventory(self.workspace, "project")
        self.assertEqual(first, second)
        self.assertEqual(first[1:], ([], True))

    def test_empty_inventory_never_starts_engine(self):
        with patch.object(search.subprocess, "Popen", side_effect=AssertionError("engine called")):
            self.assertEqual(self.run_search(), {"projects": [], "truncated": False, "agent": "explore", "root": str(self.root)})

    def test_invalid_query(self):
        for query in (None, 3, [], "", "  ", ".", "..", "../foo", "/tmp", "foo/bar", "foo\\bar", "x\n", "\tx", "x\0y", "x\x7f", "x\u202ey", "x" * 101, "\u00e9" * 51, "\ud800"):
            with self.subTest(query=repr(query)), self.assertRaises(search.SearchError):
                self.run_search(query)

    def test_unicode_casefold_and_byte_boundary(self):
        self.folder("Stra\u00dfe")
        self.assertEqual(self.run_search("STRASSE")["projects"][0]["name"], "Stra\u00dfe")
        self.assertEqual(search.request(self.payload("\u00e9" * 50))[0], "\u00e9" * 50)

    def test_invalid_request(self):
        for data in (b"{}", b"null", b"[]", b"bad", b'\xff',
                     self.payload().decode().encode("utf-16"),
                     b'{"query":"a","query":"b","profile":null,"provider_script":""}',
                     b'{"query":"a","profile":{"x":NaN},"provider_script":""}',
                     b'{"query":"a","profile":{"x":1e999},"provider_script":""}',
                     self.payload(profile="profile"), self.payload(profile={}),
                     self.payload(provider_script=None), self.payload(provider_script="\0")):
            with self.subTest(data=repr(data)), self.assertRaises(search.SearchError):
                search.request(data)

    def test_exact_cli_contract_and_isolation(self):
        self.folder("project ; $(touch NEVER)")
        with patch.dict(os.environ, {"OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS": "1",
                                    "OPENCODE_QUESTION_AUTO_RECOMMEND": "1",
                                    "OPENCODE_CONFIG_CONTENT": '{"permission":{"*":"allow"}}',
                                    "BASH_ENV": "/untrusted/script"}):
            completed = self.cli()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stderr, b"")
        result = json.loads(completed.stdout)
        self.assertEqual(set(result), {"projects", "truncated", "agent", "root"})
        self.assertEqual(result["agent"], "explore")
        self.assertEqual(result["root"], str(self.root))
        captured = json.loads(self.capture.read_text())
        cwd = captured["cwd"]
        self.assertEqual(captured["argv"], ["run", "--agent", "explore", "--format", "json", "--pure", "--dir", cwd])
        self.assertNotIn(str(self.root), cwd)
        self.assertFalse(Path(cwd).exists())
        config = captured["config"]
        self.assertEqual(config["permission"], {"*": "deny"})
        self.assertEqual(config["agent"]["explore"]["permission"], {"*": "deny"})
        self.assertEqual(config["agent"]["explore"]["mode"], "primary")
        self.assertEqual(config["share"], "disabled")
        self.assertFalse(config["autoupdate"])
        self.assertEqual(config["plugin"], [])
        env = captured["env"]
        self.assertNotIn("OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS", env)
        self.assertNotIn("OPENCODE_QUESTION_AUTO_RECOMMEND", env)
        for name in ("OPENCODE_PURE", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_DISABLE_DEFAULT_PLUGINS", "OPENCODE_DISABLE_SHARE", "OPENCODE_DISABLE_AUTOUPDATE"):
            self.assertEqual(env[name], "1")
        self.assertFalse((self.workspace / "NEVER").exists())

    def test_missing_engine_and_lookup_order(self):
        self.folder("project")
        with patch.dict(os.environ, {"SPEC_PROJECT_SEARCH_OPENCODE": "/missing/engine"}), self.assertRaises(search.SearchError):
            self.run_search()
        env = dict(os.environ)
        env.pop("SPEC_PROJECT_SEARCH_OPENCODE", None)
        with patch.dict(os.environ, env, clear=True), patch.object(search.shutil, "which", return_value=None) as which:
            with self.assertRaises(search.SearchError):
                self.run_search()
            self.assertEqual([call.args[0] for call in which.call_args_list], ["opencode-source", "opencode"])

    def test_engine_fails_closed_without_raw_logs(self):
        self.folder("project")
        for mode in ("exit", "overflow", "stderr_overflow", "raw", "invented", "duplicate", "error", "tool_call", "tool_use", "markdown", "nonfinite", "malformed", "empty"):
            with self.subTest(mode=mode), patch.dict(os.environ, {"STUB_MODE": mode}):
                completed = self.cli()
                self.assertNotEqual(completed.returncode, 0)
                self.assertEqual(completed.stdout, b"")
                self.assertNotIn(b"SECRET PROVIDER LOG", completed.stderr)
                self.assertNotIn(b"Traceback", completed.stderr)

    def test_stale_and_symlink_results(self):
        for mode in ("stale", "symlink"):
            path = self.folder("project-" + mode)
            with self.subTest(mode=mode), patch.dict(os.environ, {"STUB_MODE": mode}), self.assertRaises(search.SearchError):
                self.run_search(mode)
            if path.is_symlink():
                path.unlink()

    def test_returned_symlink_ancestor_rejected(self):
        path = self.folder("group/project")
        candidates = [str(path)]
        path.rmdir()
        path.parent.rmdir()
        (self.outside / "project").mkdir()
        path.parent.symlink_to(self.outside, target_is_directory=True)
        with self.assertRaises(search.SearchError):
            search.parse_events(self.events({"paths": candidates}), candidates, "project", self.root)

    def events(self, result):
        return json.dumps({"type": "text", "part": {"type": "text", "text": json.dumps(result)}}).encode()

    def test_invalid_result_schemas_and_nonmatches(self):
        path = str(self.folder("project"))
        other = str(self.folder("unrelated"))
        for result in ([], {"paths": [path], "extra": 1}, {"paths": path}, {"paths": [1]}, {"paths": [path, path]},
                       {"paths": [other]}, {"paths": [str(self.outside)]}, {"paths": ["project"]}, {"paths": [path] * 21}):
            with self.subTest(result=result), self.assertRaises(search.SearchError):
                search.parse_events(self.events(result), [path, other, str(self.outside)], "project", self.root)

    def test_reject_nonfinite_duplicate_or_error_events(self):
        for data in (b'{"type":"text","part":{"type":"text","text":"{\\"paths\\":[]}"},"cost":NaN}',
                     b'{"type":"text","part":{"type":"text","text":"{\\"paths\\":[]}"},"cost":1e999}',
                     b'{"type":"text","type":"text","part":{}}',
                     b'{"type":"step_finish","part":{"type":"step-finish","reason":"error"}}',
                     b'{"type":"text","part":{"type":"tool","text":"{}"}}',
                     b'{"type":"text","error":null,"part":{"type":"text","text":"{}"}}'):
            with self.subTest(data=data), self.assertRaises(search.SearchError):
                search.parse_events(data, [], "project", self.root)

    def test_more_than_twenty_results_fails(self):
        for index in range(21):
            self.folder(f"project-{index}")
        with patch.dict(os.environ, {"STUB_MODE": "too_many"}), self.assertRaises(search.SearchError):
            self.run_search()

    def test_profile_using_existing_helper(self):
        self.folder("project")
        profile = {"provider": "openai", "model": "selected-model", "endpoint": "", "apiVersion": "", "apiKey": "SECRET-key"}
        helper = SOURCE.with_name("remote-provider.bash").read_text()
        completed = self.cli(self.payload(profile=profile, provider_script=helper))
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn(b"SECRET-key", completed.stdout + completed.stderr)
        captured = json.loads(self.capture.read_text())
        self.assertEqual(captured["config"]["agent"]["explore"]["model"], "spec-execution/selected-model")
        self.assertEqual(captured["config"]["model"], "spec-execution/selected-model")
        self.assertEqual(captured["env"]["SPEC_EXECUTION_API_KEY"], "SECRET-key")
        self.assertNotIn("SPEC_EXECUTION_PROFILE", captured["env"])

    def test_profile_private_file_and_cleanup_fixture(self):
        self.folder("project")
        helper = '''exec python3 -c 'import json,os,stat
from pathlib import Path
p=Path(os.environ["SPEC_EXECUTION_PROFILE"])
assert stat.S_IMODE(p.stat().st_mode)==0o600
assert stat.S_IMODE(p.parent.stat().st_mode)==0o700
assert json.loads(p.read_text())=={"fixture":True}
print(json.dumps({"config":{"model":"fixture/model","provider":{}},"key":"fixture-key"}))'
'''
        self.run_search(profile={"fixture": True}, provider_script=helper)
        captured = json.loads(self.capture.read_text())
        self.assertEqual(captured["config"]["agent"]["explore"]["model"], "fixture/model")
        self.assertFalse(Path(captured["cwd"]).exists())

    def test_invalid_profile_fails_without_engine_or_secret(self):
        self.folder("project")
        helper = SOURCE.with_name("remote-provider.bash").read_text()
        result = self.cli(self.payload(profile={"apiKey": "PRIVATE"}, provider_script=helper))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")
        self.assertNotIn(b"PRIVATE", result.stderr)
        self.assertFalse(self.capture.exists())

    def test_no_profile_does_not_run_helper(self):
        self.folder("project")
        self.run_search(provider_script="exit 99")
        captured = json.loads(self.capture.read_text())
        self.assertNotIn("provider", captured["config"])
        self.assertNotIn("model", captured["config"]["agent"]["explore"])

    def test_provider_helper_invalid_output_and_limits(self):
        self.folder("project")
        for helper in ("printf 'not JSON'", "printf '{\"key\":NaN}'",
                       "printf '{\"config\":null,\"key\":\"secret\"}'",
                       "printf 'secret' >&2; exit 1",
                       "exec python3 -c 'print(\"x\" * 262145)'"):
            with self.subTest(helper=helper):
                result = self.cli(self.payload(profile={"fixture": True}, provider_script=helper))
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b"")
                self.assertNotIn(b"secret", result.stderr)
                self.assertFalse(self.capture.exists())

    def test_relative_engine_override_resolved_before_isolation(self):
        self.folder("project")
        relative = os.path.relpath(self.engine)
        with patch.dict(os.environ, {"SPEC_PROJECT_SEARCH_OPENCODE": relative}):
            self.assertEqual(len(self.run_search()["projects"]), 1)

    def test_workspace_retained_at_candidate_limit(self):
        for index in range(45):
            self.folder(f"a-workspace-{index:02}")
        _, candidates, truncated = search.inventory(self.workspace, "workspace")
        self.assertEqual(len(candidates), 40)
        self.assertIn(str(self.workspace), candidates)
        self.assertTrue(truncated)

    def test_split_text_events_and_duplicate_json_members(self):
        path = str(self.folder("project"))
        text = json.dumps({"paths": [path]})
        data = b"\n".join(json.dumps({"type": "text", "part": {"type": "text", "text": part}}).encode()
                           for part in (text[:10], text[10:]))
        self.assertEqual(search.parse_events(data, [path], "project", self.root), [{"name": "project", "path": path}])
        duplicate = json.dumps({"type": "text", "part": {"type": "text", "text": '{"paths":[],"paths":[]}'}}).encode()
        with self.assertRaises(search.SearchError):
            search.parse_events(duplicate, [], "project", self.root)

    def assert_child_stopped(self):
        pid = int(self.pid.read_text())
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                state = Path(f"/proc/{pid}/stat").read_text().split(")", 1)[1].split()[0]
                if state == "Z":
                    return
            except FileNotFoundError:
                return
            time.sleep(0.02)
        self.fail("child process survived cleanup")

    def test_timeout_kills_process_group_and_cleans_temp(self):
        self.folder("project")
        with patch.dict(os.environ, {"STUB_MODE": "timeout"}), patch.object(search, "TIMEOUT", 0.5):
            with self.assertRaisesRegex(search.SearchError, "timed out"):
                self.run_search()
        self.assert_child_stopped()
        self.assertFalse(Path(json.loads(self.capture.read_text())["cwd"]).exists())

    def test_sigterm_and_sigint_cleanup(self):
        self.folder("project")
        for sig in (signal.SIGTERM, signal.SIGINT):
            self.pid.unlink(missing_ok=True)
            with self.subTest(signal=sig), patch.dict(os.environ, {"STUB_MODE": "timeout"}):
                process = subprocess.Popen([sys.executable, "-I", "-B", "-c", SOURCE.read_text(), str(self.workspace)],
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    process.stdin.write(self.payload())
                    process.stdin.close()
                    deadline = time.monotonic() + 3
                    while not self.pid.exists() and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(self.pid.exists())
                    process.send_signal(sig)
                    process.wait(timeout=3)
                    self.assertNotEqual(process.returncode, 0)
                    self.assertEqual(process.stdout.read(), b"")
                    self.assertIn(b"cancelled", process.stderr.read())
                    self.assert_child_stopped()
                    self.assertFalse(Path(json.loads(self.capture.read_text())["cwd"]).exists())
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
                    process.stdout.close()
                    process.stderr.close()

    def test_oversized_input_and_invalid_workspace(self):
        result = self.cli(b"x" * (search.OUTPUT_LIMIT + 1))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")
        with self.assertRaises(search.SearchError):
            search.search(self.root / "absent", self.payload())


@unittest.skipUnless(os.environ.get("SPEC_PROJECT_SEARCH_INTEGRATION_OPENCODE"),
                     "set SPEC_PROJECT_SEARCH_INTEGRATION_OPENCODE to a real CLI for loopback-only integration")
class InstalledOpenCodeTest(unittest.TestCase):
    def test_local_provider_explore_and_real_events(self):
        engine = str(Path(os.environ["SPEC_PROJECT_SEARCH_INTEGRATION_OPENCODE"]).resolve(strict=True))
        with tempfile.TemporaryDirectory(prefix="project-search-real-cli-") as temporary:
            base = Path(temporary)
            workspace = base / "projects" / "workspace"
            workspace.mkdir(parents=True)
            candidate = workspace.parent / "project-example"
            candidate.mkdir()
            requests = []
            reasoning = False

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass

                def do_POST(self):
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    requests.append((self.path, body))
                    if self.path != "/v1/chat/completions":
                        self.send_error(403)
                        return
                    text = json.dumps({"paths": [str(candidate)]})
                    if not body.get("stream"):
                        data = json.dumps({"id": "mock-completion", "object": "chat.completion",
                                           "created": 1, "model": "local-fixture", "choices": [{"index": 0,
                                           "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                                           "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}}).encode()
                        content_type = "application/json"
                    else:
                        deltas = [{"role": "assistant", "content": ""}]
                        if reasoning:
                            deltas.append({"reasoning_content": "Rank only the supplied folder names."})
                        deltas.extend([{"content": text}, {}])
                        chunks = [{"id": "mock-completion", "object": "chat.completion.chunk", "created": 1,
                                   "model": "local-fixture", "choices": [{"index": 0, "delta": delta,
                                   "finish_reason": "stop" if index == len(deltas) - 1 else None}]}
                                  for index, delta in enumerate(deltas)]
                        data = ("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
                        content_type = "text/event-stream"
                    self.send_response(200)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)

            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                home = base / "home"
                home.mkdir()
                models = base / "models.json"
                models.write_text("{}")
                # Clear rather than copy the caller's environment: no credentials,
                # real config, inherited model selection, plugins, or telemetry.
                env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(home),
                       "OPENCODE_TEST_HOME": str(home), "OPENCODE_AUTH_CONTENT": "{}",
                       "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"),
                       "XDG_STATE_HOME": str(home / "state"), "XDG_CACHE_HOME": str(home / "cache"),
                       "TMPDIR": str(base), "SPEC_PROJECT_SEARCH_OPENCODE": engine,
                       "OPENCODE_DISABLE_MODELS_FETCH": "1", "OPENCODE_MODELS_PATH": str(models),
                       "OPENCODE_DISABLE_AUTOCOMPACT": "1", "npm_config_offline": "true",
                       "HTTP_PROXY": "http://127.0.0.1:1", "HTTPS_PROXY": "http://127.0.0.1:1",
                       "ALL_PROXY": "http://127.0.0.1:1", "NO_PROXY": "127.0.0.1,localhost"}
                profile = {"provider": "huggingface", "model": "local-fixture", "apiVersion": "", "apiKey": "",
                           "endpoint": f"http://127.0.0.1:{server.server_port}/v1"}
                payload = json.dumps({"query": "project", "profile": profile,
                                      "provider_script": SOURCE.with_name("remote-provider.bash").read_text()}).encode()
                real_run = search.run_bounded
                outputs = []

                def record_run(argv, *args):
                    output = real_run(argv, *args)
                    if argv[0] == engine:
                        outputs.append(output)
                    return output

                for reasoning in (False, True):
                    with self.subTest(reasoning=reasoning), patch.dict(os.environ, env, clear=True), patch.object(search, "run_bounded", record_run):
                        try:
                            result = search.search(workspace, payload)
                        except search.SearchError as error:
                            # These logs belong only to this credential-free fixture.
                            logs = "\n".join(path.read_text(errors="replace")[-8000:]
                                             for path in (home / "data" / "opencode" / "log").glob("*.log"))
                            self.fail(f"{error}\nFixture events: {outputs!r}\nFixture logs: {logs}")
                        self.assertEqual(result, {"projects": [{"name": candidate.name, "path": str(candidate)}],
                                                  "truncated": False, "agent": "explore", "root": str(workspace.parent)})
                        events = [json.loads(line) for line in outputs[-1].splitlines()]
                        self.assertEqual({event["type"] for event in events}, {"step_start", "text", "step_finish"})
                        databases = list((home / "data" / "opencode").glob("*.db"))
                        self.assertEqual(len(databases), 1, "expected one isolated session database")
                        database = databases[0]
                        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
                            messages = [json.loads(row[0]) for row in connection.execute("SELECT data FROM message")]
                            parts = [json.loads(row[0]) for row in connection.execute("SELECT data FROM part")]
                        assistants = [message for message in messages if message.get("role") == "assistant"]
                        self.assertTrue(assistants)
                        self.assertTrue(all(message["agent"] == "explore" for message in assistants))
                        self.assertTrue(all(message["modelID"] == "local-fixture" for message in assistants))
                        if reasoning:
                            # Real reasoning is persisted, but run omits reasoning
                            # stdout events unless --thinking was requested.
                            self.assertTrue(any(part.get("type") == "reasoning" for part in parts))
                self.assertTrue(requests)
                self.assertTrue(all(path == "/v1/chat/completions" and body["model"] == "local-fixture"
                                    for path, body in requests))
                ranking = [body for _, body in requests if "Perform project folder name-search" in json.dumps(body)]
                self.assertTrue(ranking)
                self.assertTrue(all(not body.get("tools") for body in ranking))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
