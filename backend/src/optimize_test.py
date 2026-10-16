import contextlib
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import urllib.error
import uuid

import optimize


def python(code):
    return [sys.executable, "-c", code]


def model_text(text):
    return [{"type": "message", "role": "assistant",
             "content": [{"type": "output_text", "text": text}]}]


def model_tool(argv, call_id="command"):
    return [{"type": "function_call", "name": "run_command", "call_id": call_id,
             "arguments": json.dumps({"argv": argv})}]


class OptimizerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        self.project = self.workspace / "project with spaces"
        self.project.mkdir()
        self.history = self.workspace / "history"
        self.logs = self.workspace / "reports"

    def record(self, run="run-one", name="objective.md", timestamp=1, project=None):
        directory = self.workspace / ".spec-runs" / run
        directory.mkdir(parents=True)
        output = directory / (Path(name).name + ".out")
        output.touch()
        record = directory / "invocation"
        record.write_bytes(b"\0".join(os.fsencode(value) for value in
                                     (str(project or self.project), "build", name, str(output), "")))
        os.utime(record, ns=(timestamp, timestamp))
        return record, output

    def objective(self, name="score", command=None, measure=None, **options):
        return {"name": name, "command": command or python("pass"),
                "measure": measure or python("print(1)"), "direction": "maximize", **options}

    def config(self, objectives, filename="objective.md.optim"):
        path = self.project / filename
        path.write_text(json.dumps({"version": 1, "objectives": objectives}))
        return path

    def run_optimizer(self, objectives):
        self.record()
        self.config(objectives)
        with contextlib.redirect_stdout(io.StringIO()):
            status = optimize.run(self.logs, self.workspace, self.history)
        events = [json.loads(line) for line in (self.logs / "report.jsonl").read_text().splitlines()]
        self.assertEqual((self.logs / "progress.log").read_text(), (self.logs / "report.jsonl").read_text())
        return status, events

    def harness(self, workspace, mode="optimize", payload=None, config=None, config_bytes=None):
        workspace.mkdir(exist_ok=True)
        source = Path(optimize.__file__).parent
        if payload is None:
            payload = Path(optimize.__file__).read_bytes() if mode == "optimize" else b""
        if config is None:
            config = (self.project / "objective.md.optim").read_bytes() if mode == "optimize" else b""
        run_id = str(uuid.uuid4())
        child = subprocess.Popen(
            ["bash", "-c", (source / "remote-build.bash").read_text(), "--", str(workspace),
             str(len(payload)), (source / "remote-alias.bash").read_text(),
             (source / "remote-supervisor.bash").read_text(), run_id, "optimization", mode,
             "", "", str(len(config) if config_bytes is None else config_bytes)],
            env={**os.environ, "HOME": str(workspace), "PYTHONDONTWRITEBYTECODE": "1"},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        def cleanup():
            if child.poll() is None:
                try:
                    child.stdin.write(b"C")
                    child.stdin.flush()
                except BrokenPipeError:
                    pass
                child.wait(timeout=10)
            for handle in (child.stdin, child.stdout, child.stderr):
                handle.close()

        self.addCleanup(cleanup)
        child.stdin.write(payload + config)
        child.stdin.flush()
        return child, workspace / ".spec-runs" / f"run-{run_id}"

    def test_uploaded_config_used_without_root_config_and_despite_conflicts(self):
        workspace = self.workspace / "home with ' spaces"
        workspace.mkdir()
        uploads = self.workspace / "resolved projects with spaces"
        uploads.mkdir()
        (workspace / "projects").symlink_to(uploads, target_is_directory=True)
        output = self.project / "objective.md.out"
        output.touch()
        (workspace / ".bash_history").write_text(
            f"cd '{self.project}' && nohup spec build objective.md > '{output}' &\n")
        config = json.dumps({"version": 1, "objectives": [self.objective(
            name="Caf\u00e9", patience=2, command=python(
                f"from pathlib import Path; assert Path.cwd() == Path({str(self.project)!r})"))]},
            ensure_ascii=False).encode("utf-8")
        paths = []
        for conflicts in (False, True):
            with self.subTest(conflicts=conflicts):
                if conflicts:
                    for name in ("objective.md.optim", "objective.optim", "other.optim"):
                        (self.project / name).write_text("Do not execute this conflicting config.")
                child, directory = self.harness(workspace, config=config)
                self.assertEqual(child.wait(timeout=10), 0, child.stderr.read().decode())
                events = [json.loads(line) for line in (directory / "report.jsonl").read_text().splitlines()]
                start = events[0]
                self.assertEqual(start["project"], str(self.project))
                self.assertEqual(start["filename"], "objective.md")
                self.assertEqual(start["output"], str(output))
                self.assertEqual(events[-1]["outcome"], "converged")
                path = Path(start["config"])
                self.assertTrue(path.is_absolute())
                self.assertEqual(path.parent, uploads)
                self.assertEqual(path.suffix, ".optim")
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(path.read_bytes(), config)
                self.assertNotIn(path, paths)
                paths.append(path)
        self.assertEqual(len(list(uploads.iterdir())), 2)
        self.assertTrue(all(path.read_bytes() == config for path in paths))
        self.assertTrue(all(path.read_text() == "Do not execute this conflicting config."
                            for path in self.project.glob("*.optim")))

    def test_incomplete_upload_eof_or_signal_cleans_config_without_launch(self):
        for interruption in (None, signal.SIGHUP, signal.SIGTERM):
            with self.subTest(interruption=interruption):
                workspace = self.workspace / f"upload {interruption}"
                child, directory = self.harness(workspace,
                    payload=b"from pathlib import Path; Path('launched').touch()\n",
                    config=b"partial config C", config_bytes=100)
                deadline = time.monotonic() + 5
                while not list((workspace / "projects").glob("*.optim")):
                    self.assertIsNone(child.poll(), "attachment exited before upload")
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.01)
                if interruption is not None:
                    child.send_signal(interruption)
                child.stdin.close()
                self.assertEqual(child.wait(timeout=5), 125)
                self.assertEqual((directory / "status").read_text(), "125\n")
                self.assertFalse((directory / "snapshot.md").exists())
                self.assertFalse((directory / "lease").exists())
                self.assertFalse((workspace / "launched").exists())
                self.assertEqual(list((workspace / "projects").iterdir()), [])

    def test_explicit_invalid_config_never_falls_back_to_project_config(self):
        self.record()
        self.config([self.objective(patience=2)])
        path = self.workspace / "uploaded.optim"
        for content in (None, b"", b"\xff", b"{invalid JSON"):
            with self.subTest(content=content):
                if content is not None:
                    path.write_bytes(content)
                with contextlib.redirect_stdout(io.StringIO()), mock.patch.object(
                        optimize, "config_path", side_effect=AssertionError("must not search")) as search:
                    self.assertEqual(optimize.run(self.logs, self.workspace, self.history, config=path), 1)
                search.assert_not_called()
                final = json.loads((self.logs / "report.jsonl").read_text().splitlines()[-1])
                self.assertEqual(final["outcome"], "failed")
                self.assertEqual(final["config"], str(path))

    def test_snapshot_cli_requires_explicit_config_but_standalone_retains_fallback(self):
        for script, args, status in (("snapshot.md", [], 2), ("optimize.py", [], 0),
                                     ("snapshot.md", ["/explicit/upload.optim"], 0)):
            with self.subTest(script=script), mock.patch.object(
                    sys, "argv", [script, str(self.logs), str(self.workspace), *args]), \
                    mock.patch.object(optimize, "run", return_value=0) as run, \
                    mock.patch.object(optimize.signal, "signal"), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(optimize.main(), status)
                if status == 2:
                    run.assert_not_called()
                else:
                    run.assert_called_once_with(str(self.logs), str(self.workspace),
                                                config=args[0] if args else None)

    def test_external_target_excludes_other_workspace_and_build(self):
        for git in (False, True):
            with self.subTest(git=git):
                self.project = self.workspace / f"target-{git}"
                self.project.mkdir()
                if git:
                    subprocess.run(["git", "init", "-q", str(self.project)], check=True)
                output = self.project / "objective.md.out"
                output.touch()
                self.config([self.objective(command=python(
                    "from pathlib import Path; import time; Path('entered').touch(); "
                    "exec(\"while not Path('release').exists(): time.sleep(0.01)\")"),
                    patience=2, timeout_seconds=20)])
                workspaces = [self.workspace / f"workspace-{git}-{i}" for i in range(2)]
                for workspace in workspaces:
                    workspace.mkdir()
                    (workspace / ".bash_history").write_text(
                        f"cd '{self.project}' && nohup spec build objective.md > '{output}' &\n")
                first, _ = self.harness(workspaces[0])
                try:
                    deadline = time.monotonic() + 10
                    while not (self.project / "entered").exists():
                        self.assertIsNone(first.poll(), "first optimizer exited before its step")
                        self.assertLess(time.monotonic(), deadline, "first optimizer never stepped")
                        time.sleep(0.01)
                    second, directory = self.harness(workspaces[1])
                    self.assertEqual(second.wait(timeout=10), 1, second.stderr.read().decode())
                    event = json.loads((directory / "report.jsonl").read_text())
                    self.assertEqual(event["outcome"], "failed")
                    self.assertIn("another harness is active", event["error"])
                    build, _ = self.harness(self.project, "build")
                    self.assertEqual(build.wait(timeout=10), 125)
                    self.assertIn(b"Another harness is active", build.stderr.read())
                finally:
                    (self.project / "release").touch()
                self.assertEqual(first.wait(timeout=10), 0, first.stderr.read().decode())
                retry, _ = self.harness(workspaces[1])
                self.assertEqual(retry.wait(timeout=10), 0, retry.stderr.read().decode())

    def test_target_build_lock_prevents_baseline_and_is_released_on_failure(self):
        for git in (False, True):
            with self.subTest(git=git):
                self.project = self.workspace / f"locked-target-{git}"
                self.project.mkdir()
                if git:
                    subprocess.run(["git", "init", "-q", str(self.project)], check=True)
                self.record(run=f"run-{git}", timestamp=1 + int(git))
                self.config([self.objective(measure=python("raise SystemExit(7)"))])
                directory = self.project / (".git/spec-harness" if git else ".spec-runs")
                directory.mkdir(mode=0o700)
                fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    # util-linux flock and Python flock must contend on the same inode.
                    subprocess.run(["flock", "--shared", "--nonblock", str(fd)],
                                   pass_fds=(fd,), check=True)
                    with contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(optimize.run(self.logs, self.workspace, self.history), 1)
                    event = json.loads((self.logs / "report.jsonl").read_text().splitlines()[-1])
                    self.assertIn("another harness is active", event["error"])
                finally:
                    os.close(fd)
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(optimize.run(self.logs, self.workspace, self.history), 1)
                event = json.loads((self.logs / "report.jsonl").read_text().splitlines()[-1])
                self.assertIn("command exited 7", event["error"])
                subprocess.run(["flock", "--exclusive", "--nonblock", str(directory), "true"], check=True)

    def test_supervisor_lock_reused_for_same_workspace_or_worktree(self):
        for scope in ("non-git", "git", "git-subdirectory"):
            with self.subTest(scope=scope):
                workspace = self.workspace / scope
                workspace.mkdir()
                if scope != "non-git":
                    subprocess.run(["git", "init", "-q", str(workspace)], check=True)
                self.project = workspace
                if scope == "git-subdirectory":
                    self.project = workspace / "subdirectory"
                    self.project.mkdir()
                output = self.project / "objective.md.out"
                output.touch()
                (workspace / ".bash_history").write_text(
                    f"cd '{self.project}' && nohup spec build objective.md > '{output}' &\n")
                self.config([self.objective(command=python(
                    "import os; assert 'SPEC_OPTIM_WORKSPACE_LOCK' not in os.environ"), patience=2)])
                child, directory = self.harness(workspace)
                self.assertEqual(child.wait(timeout=10), 0, child.stderr.read().decode())
                events = (directory / "report.jsonl").read_text().splitlines()
                self.assertEqual(json.loads(events[-1])["outcome"], "converged")

    def test_metadata_latest_missing_snapshot_and_preference(self):
        _, old_output = self.record(timestamp=10_000_000_000)
        newest, output = self.record("run-two", "a 'quoted' name.md", 20_000_000_000)
        os.utime(old_output, ns=(100, 100))
        self.history.write_text("#1\nnohup malicious $(touch bad) &\n")
        invocation = optimize.discover(self.workspace, self.history)
        self.assertEqual(invocation.filename, "a 'quoted' name.md")
        self.assertEqual(invocation.output, output)
        self.assertEqual(invocation.source, str(newest))
        output.unlink()
        with self.assertRaisesRegex(optimize.OptimizeError, "regular"):
            optimize.discover(self.workspace, self.history)

    def test_metadata_malformed_and_tied(self):
        record, _ = self.record(timestamp=10)
        self.record("run-two", timestamp=10)
        with self.assertRaisesRegex(optimize.OptimizeError, "equal timestamps"):
            optimize.discover(self.workspace, self.history)
        record.write_bytes(b"bad\0build\0name\0")
        with self.assertRaisesRegex(optimize.OptimizeError, "malformed"):
            optimize.discover(self.workspace, self.history)

    def test_legacy_excludes_optimization_and_rejects_ambiguity(self):
        record, output = self.record()
        record.unlink()
        (output.parent / "optimization.out").touch()
        self.assertEqual(optimize.discover(self.workspace, self.history).project, self.workspace)
        (output.parent / "another.out").touch()
        with self.assertRaisesRegex(optimize.OptimizeError, "ambiguous legacy"):
            optimize.discover(self.workspace, self.history)

    def test_history_quoted_spec_runner_and_workspace_default(self):
        output = self.project / "file name.md.out"
        output.touch()
        forms = [f"cd '{self.project}' && nohup spec build 'file name.md' > 'file name.md.out' &",
                 f"cd '{self.project}' && nohup spec build 'file name.md' > 'file name.md.out' 2>&1 &",
                 f"cd '{self.project}' && nohup run_goal 'file name.md' > 'file name.md.out' 2>&1 &",
                 f"cd '{self.project}' && nohup /tools/run-spec.sh 'file name.md' > 'file name.md.out' &",
                 f"nohup opencode-source run --thinking --agent build --dir '{self.project}' 'file name.md' > '{output}' 2>&1 &",
                 f"nohup /bin/runner run --dir '{self.project}' --agent build 'file name.md' > '{output}' &",
                 f"cd '{self.project}' && nohup /bin/runner run --dir '{self.project}' --agent build 'file name.md' > 'file name.md.out' &"]
        for form in forms:
            with self.subTest(form=form):
                self.history.write_text("#123\n" + form + "\n")
                invocation = optimize.discover(self.workspace, self.history)
                self.assertEqual(invocation.output, output)
                self.assertEqual(invocation.filename, "file name.md")
                self.assertEqual(invocation.timestamp, 123_000_000_000)
        (self.workspace / "plain.out").touch()
        self.history.write_text("nohup /usr/local/bin/spec build plain > plain.out &\n")
        self.assertEqual(optimize.discover(self.workspace, self.history).project, self.workspace)
        self.history.write_text(f"nohup runner run --dir '{self.project}' --agent build plain > plain.out &\n")
        invocation = optimize.discover(self.workspace, self.history)
        self.assertEqual(invocation.project, self.project)
        self.assertEqual(invocation.output, self.workspace / "plain.out")

    def test_history_security_and_latest_unsupported(self):
        (self.workspace / "plain.out").touch()
        valid = "nohup spec build plain > plain.out &\n"
        attacks = ["nohup spec build $(touch OWNED) > plain.out &",
                   "nohup spec build `touch OWNED` > plain.out &",
                   "nohup spec build plain > plain.out & touch OWNED",
                   "nohup spec build plain > plain.out 2>&2 &",
                   "nohup spec build plain > plain.out 2>&1 & touch OWNED",
                   "nohup bash -c 'spec build plain' > plain.out &",
                   "nohup spec build *.md > plain.out &",
                   "nohup spec build plain > plain.out &; evil",
                   "nohup spec build plain '>' plain.out '&'",
                   f"cd '{self.workspace}' '&&' nohup spec build plain > plain.out &",
                   f"cd '{self.workspace}' && nohup runner run --dir '{self.project}' --agent build plain > plain.out &",
                   "nohup spec build {one,two} > plain.out &",
                   "nohup spec build # > plain.out &",
                   "nohup spec build 'unterminated > plain.out &",
                   "/usr/bin/nohup spec build plain > plain.out &",
                   "nohup unknown task &"]
        for attack in attacks:
            self.history.write_text(valid + attack + "\n")
            with self.subTest(attack=attack), mock.patch.object(optimize.subprocess, "Popen") as popen:
                with self.assertRaises(optimize.OptimizeError):
                    optimize.discover(self.workspace, self.history)
                popen.assert_not_called()
        self.assertFalse((self.workspace / "OWNED").exists())

    def test_history_ignores_nohup_output_references(self):
        (self.workspace / "plain.out").touch()
        references = ("cat nohup.out", "tail -f '/tmp/nohup.out'", "ls nohup.log",
                      "printf '%s' 'nohup spec build example'",
                      r"printf '%s\n' 'nohup spec build example'",
                      "echo 'nohup spec build example > example.out &'",
                      "# nohup spec build example > example.out &",
                      "  # nohup 'unterminated", "ls # nohup spec build example",
                      "printf '%s' 'description' # nohup spec build example")
        for entry in references:
            with self.subTest(entry=entry):
                self.history.write_text(entry + "\n")
                self.assertIsNone(optimize.history_invocation(self.history, self.workspace))
        self.history.write_text("#123\nnohup spec build plain > plain.out &\n"
                                + "\n".join(references) + "\n")
        invocation = optimize.discover(self.workspace, self.history)
        self.assertEqual(invocation.filename, "plain")
        self.assertEqual(invocation.timestamp, 123_000_000_000)
        record, _ = self.record(timestamp=2_000_000_000)
        for entry in references:
            with self.subTest(timestamped=entry):
                self.history.write_text("#3\n" + entry + "\n")
                self.assertEqual(optimize.discover(self.workspace, self.history).source, str(record))

    def test_metadata_wins_over_undated_history(self):
        record, output = self.record()
        for entry in ("nohup python3 timelock.py unlock input output &\ncat nohup.out\n",
                      "nohup spec build other > other.out &\n",
                      "nohup spec build 'unterminated > other.out &\n"):
            with self.subTest(entry=entry):
                self.history.write_text(entry)
                invocation = optimize.discover(self.workspace, self.history)
                self.assertEqual(invocation.source, str(record))
                self.assertEqual(invocation.output, output)

    def test_newer_unsupported_history_still_blocks_metadata(self):
        record, _ = self.record(timestamp=2_000_000_000)
        for entry in ("nohup unknown task &", "nohup spec build 'unterminated",
                      "bash -c 'nohup spec build newer > newer.out &'",
                      'env bash -c "nohup spec build newer > newer.out &"',
                      "eval 'nohup spec build newer > newer.out &'",
                      "ssh host 'nohup spec build newer > newer.out &'",
                      "printf '%s' 'nohup spec build newer > newer.out &' | bash",
                      'printf "%s" "$(nohup spec build newer > newer.out &)"',
                      "printf -v 'a[$(nohup spec build newer > newer.out &)]' '%s' value",
                      "printf '%n' 'a[$(nohup spec build newer > newer.out &)]'",
                      "cd /tmp/project#2 && nohup spec build newer > newer.out &",
                      "cd /tmp/''#2 && nohup spec build newer > newer.out &",
                      r"cd /tmp/project\ #2 && nohup spec build newer > newer.out &",
                      "printf ' # nohup spec build newer"):
            with self.subTest(entry=entry), mock.patch.object(optimize.subprocess, "Popen") as popen:
                self.history.write_text("#1\nnohup spec build older > older.out &\n"
                                        + "#3\n" + entry + "\ncat nohup.out\n")
                with self.assertRaisesRegex(optimize.OptimizeError, "unsupported or ambiguous"):
                    optimize.history_invocation(self.history, self.workspace)
                with self.assertRaisesRegex(optimize.OptimizeError, "unsupported or ambiguous"):
                    optimize.discover(self.workspace, self.history)
                for prefix in ("#1\n", ""):
                    self.history.write_text(prefix + entry + "\n")
                    self.assertEqual(optimize.discover(self.workspace, self.history).source, str(record))
                popen.assert_not_called()

    def test_history_legacy_ordering(self):
        record, output = self.record()
        record.unlink()
        os.utime(output, ns=(1_000_000_000, 1_000_000_000))
        (self.workspace / "new.out").touch()
        self.history.write_text("#2\nnohup spec build new > new.out &\n")
        self.assertEqual(optimize.discover(self.workspace, self.history).filename, "new")
        self.history.write_text("nohup spec build new > new.out &\n")
        with self.assertRaisesRegex(optimize.OptimizeError, "cannot order"):
            optimize.discover(self.workspace, self.history)

    def test_history_and_metadata_ordering(self):
        self.record(timestamp=2_000_000_000)
        output = self.workspace / "new.out"
        output.touch()
        command = "nohup spec build new > new.out 2>&1 &\n"
        self.history.write_text("#3\n" + command)
        self.assertEqual(optimize.discover(self.workspace, self.history).output, output)
        self.history.write_text("#1\n" + command)
        self.assertEqual(optimize.discover(self.workspace, self.history).filename, "objective.md")
        self.history.write_text("#2\n" + command)
        with self.assertRaisesRegex(optimize.OptimizeError, "equal timestamps"):
            optimize.discover(self.workspace, self.history)
        self.history.write_text(command)
        self.assertEqual(optimize.discover(self.workspace, self.history).filename, "objective.md")

    def test_config_selection(self):
        self.record()
        invocation = optimize.discover(self.workspace, self.history)
        unrelated = self.config([self.objective()], "other.optim")
        self.assertEqual(optimize.config_path(invocation), unrelated)
        self.config([self.objective()], "second.optim")
        with self.assertRaises(optimize.OptimizeError):
            optimize.config_path(invocation)
        stem = self.config([self.objective()], "objective.optim")
        self.assertEqual(optimize.config_path(invocation), stem)
        exact = self.config([self.objective()])
        self.assertEqual(optimize.config_path(invocation), exact)

    def test_config_setup_errors_include_target_and_remedy(self):
        record, output = self.record(name="specs/objective.md")
        for filenames, message in (([], "no .optim file found"),
                                   (["other.optim", "second.optim"], "ambiguous .optim files")):
            with self.subTest(filenames=filenames):
                for filename in filenames:
                    self.config([self.objective()], filename)
                with mock.patch.object(optimize, "ResponsesOptimizer") as agent, \
                        mock.patch.object(optimize, "optimize") as scheduler, \
                        contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(optimize.run(self.logs, self.workspace, self.history), 1)
                agent.assert_not_called()
                scheduler.assert_not_called()
                rows = [json.loads(line) for line in (self.logs / "report.jsonl").read_text().splitlines()]
                event = rows[-1]
                self.assertEqual(event["event"], "final")
                self.assertEqual(event["outcome"], "failed")
                self.assertEqual(event["project"], str(self.project))
                self.assertEqual(event["filename"], "specs/objective.md")
                self.assertEqual(event["output"], str(output))
                self.assertEqual(event["source"], str(record))
                self.assertIn(message, event["error"])
                for filename in ["objective.md.optim", "objective.optim", *filenames]:
                    self.assertIn(str(self.project / filename), event["error"])
                if not filenames:
                    self.assertIn("execution host", event["error"])
                    self.assertIn("free-form UTF-8 prose", event["error"])
                self.assertEqual(sorted(path.name for path in self.project.glob("*.optim")), filenames)
                self.assertEqual((self.logs / "progress.log").read_text(),
                                 (self.logs / "report.jsonl").read_text())

    def test_nonregular_config_is_not_reported_as_missing(self):
        self.record()
        invocation = optimize.discover(self.workspace, self.history)
        for filename in ("other.optim", "objective.optim", "objective.md.optim"):
            with self.subTest(filename=filename):
                path = self.project / filename
                path.mkdir()
                with self.assertRaisesRegex(optimize.OptimizeError, "config is not a regular file") as error:
                    optimize.config_path(invocation)
                self.assertIn(str(path), str(error.exception))
                path.rmdir()

    def test_bom_json_config_does_not_construct_responses_optimizer(self):
        self.record()
        path = self.config([self.objective(patience=2)])
        data = b"\xef\xbb\xbf" + path.read_bytes()
        path.write_bytes(data)
        with mock.patch.object(optimize, "ResponsesOptimizer") as agent, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(optimize.run(self.logs, self.workspace, self.history), 0)
        agent.assert_not_called()
        rows = [json.loads(line) for line in (self.logs / "report.jsonl").read_text().splitlines()]
        self.assertEqual(rows[-1]["outcome"], "converged")
        self.assertEqual(path.read_bytes(), data)

    def test_reject_invalid_config(self):
        invalid = [{"patience": 1}, {"patience": True}, {"patience": 10001},
                   {"absolute_tolerance": -1}, {"relative_tolerance": float("nan")},
                   {"relative_tolerance": 2}, {"absolute_tolerance": 1e101},
                   {"timeout_seconds": 0}, {"timeout_seconds": 86401},
                   {"command": "echo hi"}, {"command": []}, {"measure": ["x\0"]},
                   {"direction": "sideways"}, {"name": ""}, {"extra": 1}]
        for options in invalid:
            objective = self.objective()
            objective.update(options)
            with self.subTest(options=options), self.assertRaises(optimize.OptimizeError):
                optimize.load_config(self.config([objective]))
        for text in ('{"version":1,"version":1,"objectives":[]}',
                     '{"version":true,"objectives":[]}',
                     '{"version":1,"objectives":[]}',
                     '{"version":1,"objectives":[NaN]}'):
            path = self.project / "invalid.optim"
            path.write_text(text)
            with self.assertRaises(optimize.OptimizeError):
                optimize.load_config(path)
        with self.assertRaises(optimize.OptimizeError):
            optimize.load_config(self.config([self.objective(), self.objective()]))

    def test_discovery_and_config_errors_are_reported(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(optimize.run(self.logs, self.workspace, self.history), 1)
        self.assertEqual(json.loads((self.logs / "report.jsonl").read_text())["outcome"], "failed")
        self.record()
        path = self.config([self.objective()])
        path.write_text("{malformed JSON")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(optimize.run(self.logs, self.workspace, self.history), 1)
        rows = [json.loads(line) for line in (self.logs / "report.jsonl").read_text().splitlines()]
        self.assertEqual(rows[-1]["outcome"], "failed")
        self.assertIn("JSONDecodeError", rows[-1]["error"])

    def test_nonregular_metadata_is_rejected(self):
        record, _ = self.record()
        record.unlink()
        os.mkfifo(record)
        with self.assertRaisesRegex(optimize.OptimizeError, "regular file"):
            optimize.discover(self.workspace, self.history)

    def test_multi_objective_gains_and_patience(self):
        def objective(name, direction, start, target, delta):
            command = python(f"from pathlib import Path; p=Path('{name}'); "
                             f"v=float(p.read_text()) if p.exists() else {start}; "
                             f"p.write_text(str({'min' if delta > 0 else 'max'}({target},v+({delta}))))")
            measure = python(f"from pathlib import Path; p=Path('{name}'); "
                             f"print(p.read_text() if p.exists() else {start})")
            return self.objective(name, command, measure, direction=direction, patience=2)
        status, events = self.run_optimizer([objective("up", "maximize", 0, 2, 1),
                                             objective("down", "minimize", 10, 6, -2)])
        self.assertEqual(status, 0)
        self.assertEqual([e["score"] for e in events if e["event"] == "baseline"], [0, 10])
        self.assertEqual(events[-1]["iterations"], 4)
        self.assertEqual([e["cumulative_gain"] for e in events[-1]["objectives"]], [2, 4])
        up = [e for e in events if e["event"] == "iteration" and e["objective"] == "up"]
        self.assertEqual([e["gain"] for e in up], [1, 1, 0, 0])
        self.assertEqual([e["marginal_difference"] for e in up], [None, 0, -1, 0])

    def test_regression_resets_and_constant_gain_is_not_plateau(self):
        command = python("import os; from pathlib import Path; "
                         "i=int(os.environ['SPEC_OPTIM_ITERATION']); "
                         "Path('score').write_text(str([0,1,2,2,0,0,0][min(i,6)]))")
        measure = python("from pathlib import Path; p=Path('score'); print(p.read_text() if p.exists() else 0)")
        status, events = self.run_optimizer([self.objective(command=command, measure=measure, patience=2)])
        self.assertEqual(status, 0)
        rows = [e for e in events if e["event"] == "iteration"]
        self.assertEqual([e["stable_iterations"] for e in rows], [0, 0, 1, 0, 1, 2])
        self.assertEqual(rows[3]["gain"], -2)

    def test_converged_objective_reactivated_by_other_step(self):
        a = self.objective("a", python("pass"),
                           python("from pathlib import Path; p=Path('a'); print(p.read_text() if p.exists() else 0)"),
                           patience=2)
        b = self.objective("b", python("import os; from pathlib import Path; "
                                      "i=int(os.environ['SPEC_OPTIM_ITERATION']); "
                                      "Path('b').write_text(str(min(i,3))); "
                                      "Path('a').write_text(str(int(i>=3)))"),
                           python("from pathlib import Path; p=Path('b'); print(p.read_text() if p.exists() else 0)"),
                           patience=2)
        status, events = self.run_optimizer([a, b])
        self.assertEqual(status, 0)
        rows = [e for e in events if e["event"] == "iteration" and e["objective"] == "a"]
        self.assertEqual([e["stepped"] for e in rows], [True, True, False, True, True])
        self.assertEqual(rows[2]["stable_iterations"], 0)
        self.assertEqual(events[-1]["iterations"], 5)

    def test_default_patience_and_relative_tolerance(self):
        command = python("import os; from pathlib import Path; Path('score').write_text("
                         "str(1000000 + int(os.environ['SPEC_OPTIM_ITERATION'])))")
        measure = python("from pathlib import Path; p=Path('score'); print(p.read_text() if p.exists() else 1000000)")
        status, events = self.run_optimizer([self.objective(command=command, measure=measure)])
        self.assertEqual(status, 0)
        self.assertEqual(events[-1]["iterations"], 3)

    def test_failure_and_nonfinite_metrics(self):
        cases = [(python("raise SystemExit(7)"), python("print(0)")),
                 (python("pass"), python("raise SystemExit(3)")),
                 (python("pass"), python("print('NaN')")),
                 (python("pass"), python("print('1e999')")),
                 (python("pass"), python("print('1 2')")),
                 (python("pass"), python("pass")),
                 (python("pass"), python("print('1'*5000)")),
                 (["/nonexistent/optimizer-command"], python("print(0)"))]
        self.record()
        for index, (command, measure) in enumerate(cases):
            self.config([self.objective(command=command, measure=measure)])
            logs = self.workspace / f"failure-{index}"
            with self.subTest(index=index), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(optimize.run(logs, self.workspace, self.history), 1)
                rows = [json.loads(line) for line in (logs / "report.jsonl").read_text().splitlines()]
                self.assertEqual(rows[-1]["outcome"], "failed")
                self.assertIn("error", rows[-1])

    def test_timeout_and_bounded_command_logging(self):
        status, events = self.run_optimizer([self.objective(command=python("import time; time.sleep(10)"),
                                                            timeout_seconds=0.2)])
        self.assertEqual(status, 1)
        self.assertIn("timeout", events[-1]["error"])
        reporter = optimize.Reporter(self.workspace / "bounded")
        self.addCleanup(reporter.close)
        invocation = optimize.discover(self.workspace, self.history)
        objective = optimize.load_config(self.config([self.objective(timeout_seconds=5)]))[0]
        with mock.patch.object(optimize, "COMMAND_LOG_LIMIT", 1024):
            optimize.execute(python("import sys; sys.stdout.write('x'*200000); sys.stderr.write('y'*200000)"),
                             invocation, objective, 1, "command", reporter)
        self.assertEqual((self.workspace / "bounded" / "commands.log").stat().st_size, 1024)

    def test_measure_failure_after_baseline_and_arithmetic_overflow(self):
        self.record()
        measures = ["import os; print(0 if os.environ['SPEC_OPTIM_ITERATION']=='0' else 'NaN')",
                    "import os; print(-1e308 if os.environ['SPEC_OPTIM_ITERATION']=='0' else 1e308)"]
        for index, measure in enumerate(measures):
            self.config([self.objective(measure=python(measure))])
            logs = self.workspace / f"late-failure-{index}"
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(optimize.run(logs, self.workspace, self.history), 1)
            rows = [json.loads(line) for line in (logs / "report.jsonl").read_text().splitlines()]
            self.assertEqual(rows[1]["event"], "baseline")
            self.assertEqual(rows[-1]["outcome"], "failed")

    def test_snapshot_cli_environment_and_no_shell(self):
        _, output = self.record()
        code = ("import os; from pathlib import Path; "
                f"assert Path.cwd() == Path({str(self.project)!r}); "
                f"assert os.environ['SPEC_OPTIM_PROJECT'] == {str(self.project)!r}; "
                "assert os.environ['SPEC_OPTIM_FILENAME'] == 'objective.md'; "
                f"assert os.environ['SPEC_OPTIM_OUTPUT'] == {str(output)!r}; "
                "assert os.environ['SPEC_OPTIM_OBJECTIVE'] == 'score'; "
                "assert int(os.environ['SPEC_OPTIM_ITERATION']) >= 1; "
                "import sys; assert sys.argv[1] == '$(touch OWNED)'")
        config = self.config([self.objective(command=python(code) + ["$(touch OWNED)"], patience=2)])
        snapshot = self.workspace / "snapshot.md"
        snapshot.write_bytes(Path(optimize.__file__).read_bytes())
        result = subprocess.run([sys.executable, "-u", str(snapshot), str(self.logs), str(self.workspace), str(config)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
                                env={**os.environ, "HOME": str(self.workspace)})
        self.assertEqual(result.returncode, 0, result.stderr.decode() + result.stdout.decode())
        self.assertFalse((self.project / "OWNED").exists())
        self.assertEqual(json.loads(result.stdout.splitlines()[-1])["outcome"], "converged")

    @mock.patch.object(optimize.ResponsesOptimizer, "build", return_value={"exit_code": 0, "output": "Built"})
    def test_responses_prose_plan_tools_and_measured_multi_objective_convergence(self, builder):
        _, output = self.record()
        source = "# Already implemented\nImprove throughput and reduce latency.\n"
        spec = "Measure throughput and latency; optimize each until two unchanged rounds.\n"
        (self.project / "objective.md").write_text(source)
        path = self.project / "objective.md.optim"
        path.write_text(spec)
        output.write_text("initial build evidence\n")
        objectives = []
        for name, direction, baseline, expression in (
                ("up", "maximize", 0, "min(i, 1)"),
                ("down", "minimize", 10, "max(6, 10 - 2*i)")):
            command = python(
                "import os, sys; from pathlib import Path; "
                f"assert Path.cwd() == Path({str(self.project)!r}); "
                f"assert os.environ['SPEC_OPTIM_OBJECTIVE'] == {name!r}; "
                "assert sys.argv[1] == '$(touch OWNED)'; "
                "i=int(os.environ['SPEC_OPTIM_ITERATION']); "
                f"Path({name!r}).write_text(str({expression})); print('applied', {name!r}, i)"
            ) + ["$(touch OWNED)"]
            measure = python(f"from pathlib import Path; p=Path({name!r}); "
                             f"print(p.read_text() if p.exists() else {baseline})")
            objectives.append(self.objective(name, command, measure, direction=direction,
                                             patience=2, absolute_tolerance=0, relative_tolerance=0))
        plan = json.dumps({"version": 1, "objectives": objectives})
        outputs = [model_tool(python("from pathlib import Path; print(Path('objective.md').read_text())"),
                              "inspect"), model_text(plan)]
        expected_steps = []
        for iteration in range(1, 5):
            for objective in objectives:
                if objective["name"] == "up" and iteration == 4:
                    continue
                expected_steps.append((objective["name"], iteration))
                outputs.extend([model_tool(objective["command"], f"{objective['name']}-{iteration}"),
                                model_text("Converged; stop now. Claimed score: 999.")])
        remaining = iter(outputs)
        requests = []

        def request(messages):
            # agent() mutates this conversation after each request.
            requests.append(json.loads(json.dumps(messages)))
            return next(remaining)

        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=True), \
                mock.patch.object(optimize.urllib.request, "build_opener",
                                  side_effect=AssertionError("unexpected network request")) as opener, \
                mock.patch.object(optimize.ResponsesOptimizer, "request", side_effect=request) as api, \
                contextlib.redirect_stdout(io.StringIO()):
            status = optimize.run(self.logs, self.workspace, self.history)
        events = [json.loads(line) for line in (self.logs / "report.jsonl").read_text().splitlines()]
        self.assertEqual(status, 0, events[-1])
        opener.assert_not_called()
        self.assertEqual(api.call_count, len(outputs))
        self.assertEqual(path.read_text(), spec)
        self.assertEqual((self.project / "objective.md").read_text(), source)
        self.assertFalse((self.project / "OWNED").exists())
        context = json.loads(requests[0][0]["content"].split("\n\n", 1)[0])
        self.assertEqual(context, {"project": str(self.project), "filename": "objective.md",
                                   "objectives": source, "optim_spec": spec,
                                   "build_output_tail": output.read_text(), "build_output_truncated": False})
        self.assertEqual(requests[1][-1]["call_id"], "inspect")
        self.assertEqual(json.loads(requests[1][-1]["output"]),
                         {"exit_code": 0, "output": source + "\n", "truncated": False})
        self.assertEqual(requests[3][-1]["call_id"], "up-1")
        self.assertEqual(json.loads(requests[3][-1]["output"]),
                         {"exit_code": 0, "output": "applied up 1\n", "truncated": False})
        self.assertTrue(all(optimize.COMPLETION_CONVENTION in request[0]["content"] for request in requests))
        previous = json.loads(requests[6][0]["content"].split("follow:\n", 1)[1])
        self.assertEqual(previous["iteration"], 2)
        self.assertEqual([state["score"] for state in previous["states"]], [1, 8])
        self.assertEqual([state["gain"] for state in previous["states"]], [1, 2])
        self.assertTrue(all(state["summary"].startswith("Converged") for state in previous["states"]))
        plans = [event for event in events if event["event"] == "plan"]
        self.assertEqual(len(plans), 1)
        self.assertEqual(plans[0]["model"], "gpt-6-sol")
        self.assertEqual(plans[0]["objectives"], [{**objective, "timeout_seconds": None}
                                                 for objective in objectives])
        baselines = [event for event in events if event["event"] == "baseline"]
        self.assertEqual([(event["objective"], event["iteration"], event["score"])
                          for event in baselines], [("up", 0, 0), ("down", 0, 10)])
        self.assertLess(events.index(plans[0]), events.index(baselines[0]))
        steps = [event for event in events if event["event"] == "model_step"]
        self.assertEqual([(event["objective"], event["iteration"]) for event in steps], expected_steps)
        self.assertEqual([(call.args[0]["name"], call.args[1]) for call in builder.call_args_list], expected_steps)
        self.assertLess(events.index(baselines[-1]), events.index(steps[0]))
        for name, scores, gains, marginal, stable, stepped in (
                ("up", [1, 1, 1, 1], [1, 0, 0, 0], [None, -1, 0, 0], [0, 1, 2, 2],
                 [True, True, True, False]),
                ("down", [8, 6, 6, 6], [2, 2, 0, 0], [None, 0, -2, 0], [0, 0, 1, 2],
                 [True, True, True, True])):
            rows = [event for event in events if event["event"] == "iteration" and event["objective"] == name]
            self.assertEqual([row["iteration"] for row in rows], [1, 2, 3, 4])
            for field, expected in (("score", scores), ("gain", gains), ("marginal_difference", marginal),
                                    ("stable_iterations", stable), ("stepped", stepped)):
                self.assertEqual([row[field] for row in rows], expected, (name, field))
            self.assertEqual([row["cumulative_gain"] for row in rows],
                             [sum(gains[:index + 1]) for index in range(4)])
        final = events[-1]
        self.assertEqual((final["event"], final["outcome"], final["iterations"]), ("final", "converged", 4))
        self.assertEqual(final["objectives"], [
            {"name": "up", "baseline": 0, "score": 1, "cumulative_gain": 1},
            {"name": "down", "baseline": 10, "score": 6, "cumulative_gain": 4}])
        self.assertEqual((self.logs / "progress.log").read_text(), (self.logs / "report.jsonl").read_text())
        self.assertIn("applied down 4", (self.logs / "commands.log").read_text())

    def test_prose_builder_subprocess_convergence_failures_and_full_context(self):
        self.record()
        (self.project / "objective.md").write_text("# Preserve completed work\nImprove score\n")
        spec = "Refactor using the builder and explorer, measure score.\n" + "context " * 20000 + "END_OF_SPEC"
        (self.project / "objective.md.optim").write_text(spec)
        launcher = self.workspace / "fake opencode"
        launcher.write_text(f"#!{sys.executable}\n" + """
import json, os, sys, time
from pathlib import Path
assert sys.argv[1:4] == ['run', '--dir', str(Path.cwd())]
assert sys.argv[4:10] == ['--agent', 'build', '--auto', '--format', 'json', '--']
assert 'SPEC_OPTIM_WORKSPACE_LOCK' not in os.environ
assert os.fstat(0).st_mode & 0o777 == 0o600
prompt = sys.stdin.read()
assert len(prompt) > 128 * 1024
assert 'END_OF_SPEC' in prompt
assert 'explore subagent' in prompt
assert '# Preserve completed work' in prompt
assert 'modify measurement definitions' in prompt
assert 'nested spec build/Optimize harness' in prompt
iteration = int(os.environ['SPEC_OPTIM_ITERATION'])
state = json.loads(prompt.rsplit('\\n\\n', 1)[1])
assert state['iteration'] == iteration
assert state['objective']['name'] == 'score'
assert state['states'][0]['score'] == min(iteration - 1, 2)
with Path('builder-calls').open('a') as log:
    log.write(json.dumps({'iteration': iteration}) + '\\n')
if os.environ['BUILDER_TEST_MODE'] in ('missing-agent', 'subagent', 'split-warning'):
    warning = ('agent "build" ' + ('is a subagent, not a primary agent.'
               if os.environ['BUILDER_TEST_MODE'] == 'subagent' else 'not found.')
               + ' Falling back to default agent')
    if os.environ['BUILDER_TEST_MODE'] == 'split-warning':
        print('diagnostic ' * 10000, file=sys.stderr, flush=True)
        split = warning.index('default')
        print(warning[:split], end='', file=sys.stderr, flush=True)
        time.sleep(0.1)
        print(json.dumps({'type': 'text', 'part': {'text': 'interleaved ' * 10000}}), flush=True)
        time.sleep(0.1)
        print(warning[split:], file=sys.stderr, flush=True)
    else:
        print(warning, file=sys.stderr, flush=True)
    sys.exit(0)
if os.environ['BUILDER_TEST_MODE'] == 'timeout':
    time.sleep(30)
if os.environ['BUILDER_TEST_MODE'] == 'failed':
    print('builder failed', file=sys.stderr)
    sys.exit(7)
Path('score').write_text(str(min(iteration, 2)))
Path('built').write_text(str(iteration))
print('diagnostic ' * 10000, file=sys.stderr, flush=True)
print(json.dumps({'type': 'tool_use', 'part': {'state': {'output': 'verbose output ' * 10000}}}))
print(json.dumps({'type': 'tool_use', 'part': {'state': {'output': 'Falling back to default agent'}}}))
print(json.dumps({'type': 'text', 'part': {
    'text': f'Actual builder attempt {iteration}; tested Falling back to default agent'}}))
""")
        launcher.chmod(0o700)
        for mode in ("success", "failed", "missing", "timeout", "missing-agent", "subagent", "split-warning"):
            for filename in ("score", "built", "builder-calls"):
                (self.project / filename).unlink(missing_ok=True)
            objective = self.objective(command=python(
                "import os; from pathlib import Path; "
                "assert Path('built').read_text() == os.environ['SPEC_OPTIM_ITERATION']"),
                measure=python("from pathlib import Path; p=Path('score'); print(p.read_text() if p.exists() else 0)"),
                patience=2, absolute_tolerance=0, relative_tolerance=0,
                timeout_seconds=0.5 if mode == "timeout" else 10)
            outputs = [model_text(json.dumps({"version": 1, "objectives": [objective]}))]
            if mode == "success":
                outputs.extend([model_text("Validated builder result; claimed convergence.")] * 4)
            logs = self.workspace / mode
            with self.subTest(mode=mode), mock.patch.dict(os.environ, {
                    "OPENAI_API_KEY": "test-key", "BUILDER_TEST_MODE": mode,
                    "SPEC_OPTIM_OPENCODE": str(launcher) if mode != "missing" else str(launcher) + "-missing"
                    }, clear=True), mock.patch.object(optimize.ResponsesOptimizer, "request", side_effect=outputs) as api, \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(optimize.run(logs, self.workspace, self.history), 0 if mode == "success" else 1)
            rows = [json.loads(line) for line in (logs / "report.jsonl").read_text().splitlines()]
            self.assertEqual((logs / "progress.log").read_text(), (logs / "report.jsonl").read_text())
            starts = [row for row in rows if row["event"] == "builder_start"]
            self.assertEqual(len(starts), 4 if mode == "success" else 1)
            if mode == "success":
                iterations = [row for row in rows if row["event"] == "iteration"]
                self.assertEqual([row["gain"] for row in iterations], [1, 1, 0, 0])
                self.assertEqual([row["marginal_difference"] for row in iterations], [None, 0, -1, 0])
                self.assertEqual(rows[-1]["outcome"], "converged")
                self.assertEqual(rows[-1]["iterations"], 4)
                results = [row for row in rows if row["event"] == "builder_result"]
                self.assertEqual([row["exit_code"] for row in results], [0] * 4)
                self.assertTrue(all(row["truncated"] for row in results))
                self.assertTrue(all(len(row["output"].encode()) <= optimize.TOOL_OUTPUT_LIMIT for row in results))
                self.assertIn("Actual builder attempt 4", results[-1]["output"])
                self.assertIn('"type": "tool_use"', results[-1]["output"])
                self.assertIn("Falling back to default agent", results[-1]["output"])
                self.assertIn("Actual builder attempt 4", api.call_args.args[0][0]["content"])
                self.assertIn("Actual builder attempt 4", (logs / "commands.log").read_text())
            else:
                self.assertEqual(rows[-1]["outcome"], "failed")
                self.assertFalse(any(row["event"] == "iteration" for row in rows))
                expected = {"failed": "builder exited 7", "missing": "builder exited 127", "timeout": "timeout after",
                            "missing-agent": "refusing fallback", "subagent": "refusing fallback",
                            "split-warning": "refusing fallback"}
                self.assertIn(expected[mode], rows[-1]["error"])

    def test_supervised_builder_timeout_and_cancellation_stop_descendants(self):
        launcher = self.workspace / "builder"
        launcher.write_text(f"#!{sys.executable}\n" + """
import os, signal, subprocess, sys, time
from pathlib import Path
if sys.argv[1:] == ['orphan']:
    subprocess.Popen([sys.executable, __file__, 'grandchild'], start_new_session=True)
    sys.exit(0)
if sys.argv[1:] in (['worker'], ['grandchild']):
    name = sys.argv[1]
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    Path(name + '-pid').write_text(str(os.getpid()))
    if name == 'worker':
        subprocess.run([sys.executable, __file__, 'orphan'], start_new_session=True, check=True)
    while True:
        Path(name + '-heartbeat').write_text(str(time.time_ns()))
        time.sleep(0.01)
sys.stdin.read()
subprocess.Popen([sys.executable, __file__, 'worker'], start_new_session=True)
while not all(Path(name + '-heartbeat').exists() for name in ('worker', 'grandchild')):
    time.sleep(0.01)
Path('guardian-pid').write_text(str(os.getppid()))
Path('builder-pid').write_text(str(os.getpid()))
if os.environ['DESCENDANT_TEST_MODE'] in ('success', 'failure'):
    while not Path('release').exists():
        time.sleep(0.01)
    sys.exit(0 if os.environ['DESCENDANT_TEST_MODE'] == 'success' else 7)
time.sleep(60)
""")
        launcher.chmod(0o700)
        for mode, external in ((mode, external) for mode in ("timeout", "cancel", "success", "failure")
                               for external in (False, True)):
            with self.subTest(mode=mode, external=external):
                workspace = self.workspace / f"{mode}-{external}"
                workspace.mkdir()
                self.project = workspace / "target" if external else workspace
                self.project.mkdir(exist_ok=True)
                output = self.project / "objective.md.out"
                output.touch()
                (workspace / ".bash_history").write_text(
                    f"cd '{self.project}' && nohup spec build objective.md > '{output}' &\n")
                (self.project / "objective.md.optim").write_text("Refactor until score plateaus.")
                plan = model_text(json.dumps({"version": 1, "objectives": [
                    self.objective(timeout_seconds=2 if mode == "timeout" else None)]}))
                payload = (f"import sys\nsys.path.insert(0, {str(Path(optimize.__file__).parent)!r})\n"
                           f"import optimize\noptimize.ResponsesOptimizer.request = lambda self, messages: {plan!r}\n"
                           + """
from contextlib import contextmanager
from pathlib import Path
import subprocess
unrelated = subprocess.Popen([sys.executable, '-c',
    "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
    "print('ready',flush=True); time.sleep(60)"], stdout=subprocess.PIPE, text=True)
assert unrelated.stdout.readline().strip() == 'ready'
original_lock = optimize.project_lock
@contextmanager
def checked_lock(project):
    with original_lock(project):
        try:
            yield
        finally:
            for name in ('builder', 'worker', 'grandchild', 'guardian'):
                pid = int((project / (name + '-pid')).read_text())
                assert not Path(f'/proc/{pid}').exists(), f'{name} survived until lock release'
            assert unrelated.poll() is None, 'cleanup killed an unrelated child of the caller'
            assert subprocess.run(['flock', '--exclusive', '--nonblock',
                                   str(project / '.spec-runs'), 'true']).returncode == 1
            (project / 'cleaned-before-unlock').touch()
optimize.project_lock = checked_lock
try:
    sys.exit(optimize.main())
finally:
    unrelated.kill()
    unrelated.wait()
    unrelated.stdout.close()
""").encode()
                with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "test-key",
                                                 "SPEC_OPTIM_OPENCODE": str(launcher),
                                                 "DESCENDANT_TEST_MODE": mode}):
                    child, directory = self.harness(workspace, payload=payload)
                deadline = time.monotonic() + 10
                while not (self.project / "builder-pid").exists():
                    self.assertIsNone(child.poll(), "supervisor exited before starting builder")
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.01)
                # Pin fixture identities for cleanup even if a regression leaks them.
                for name in ("worker", "grandchild"):
                    fd = os.pidfd_open(int((self.project / f"{name}-pid").read_text()))

                    def cleanup(fd=fd):
                        try:
                            signal.pidfd_send_signal(fd, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        finally:
                            os.close(fd)

                    self.addCleanup(cleanup)
                if mode == "cancel":
                    child.stdin.write(b"C")
                    child.stdin.flush()
                elif mode in ("success", "failure"):
                    (self.project / "release").touch()
                self.assertNotEqual(child.wait(timeout=15), 0)
                rows = [json.loads(line) for line in (directory / "report.jsonl").read_text().splitlines()]
                self.assertEqual(rows[-1]["outcome"], "interrupted" if mode == "cancel" else "failed")
                self.assertFalse(any(row["event"] == "iteration" for row in rows))
                self.assertTrue((self.project / "cleaned-before-unlock").exists(), rows[-1])
                if mode in ("success", "failure"):
                    self.assertIn(f"builder exited {1 if mode == 'success' else 7}", rows[-1]["error"])
                for name in ("worker", "grandchild"):
                    heartbeat = (self.project / f"{name}-heartbeat").read_text()
                    time.sleep(0.1)
                    self.assertEqual((self.project / f"{name}-heartbeat").read_text(), heartbeat)
                subprocess.run(["flock", "--exclusive", "--nonblock", str(self.project / ".spec-runs"), "true"],
                               check=True)

    def test_responses_request_model_prompt_endpoint_auth_and_no_redirects(self):
        _, output = self.record()
        output.write_bytes(b"old prefix" + b"x" * optimize.TOOL_OUTPUT_LIMIT)
        invocation = optimize.discover(self.workspace, self.history)
        messages = [{"role": "user", "content": "optimization context"}]
        result = model_text("planned")
        cases = [({"OPENAI_API_KEY": "openai-test-key"}, "https://api.openai.com/v1/responses",
                  "authorization", "Bearer openai-test-key")]
        for suffix in ("", "/", "/openai/v1", "/openai/v1/", "/openai/v1/responses"):
            cases.append(({"AZURE_OPENAI_ENDPOINT": "https://example.openai.azure.com" + suffix,
                           "AZURE_OPENAI_API_KEY": "azure-test-key", "OPENAI_API_KEY": "not-used"},
                          "https://example.openai.azure.com/openai/v1/responses", "api-key", "azure-test-key"))
        for env, url, header, key in cases:
            with self.subTest(env=env), mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.object(optimize.urllib.request, "build_opener") as build_opener:
                response = build_opener.return_value.open.return_value.__enter__.return_value
                response.read.return_value = json.dumps({"status": "completed", "output": result}).encode()
                agent = optimize.ResponsesOptimizer("Optimize prose", invocation, mock.Mock())
                self.assertEqual(agent.request(messages), result)
                context = json.loads(agent.context)
                self.assertEqual(context["build_output_tail"], "x" * optimize.TOOL_OUTPUT_LIMIT)
                self.assertTrue(context["build_output_truncated"])
                build_opener.return_value.open.assert_called_once()
                args, kwargs = build_opener.return_value.open.call_args
                request, = args
                self.assertEqual(kwargs, {"timeout": 300})
                self.assertEqual(request.full_url, url)
                self.assertEqual(request.get_method(), "POST")
                headers = {name.lower(): value for name, value in request.header_items()}
                self.assertEqual(headers, {"content-type": "application/json", header: key})
                payload = json.loads(request.data)
                self.assertEqual(payload["model"], "gpt-6-sol")
                self.assertEqual(payload["instructions"], "Optimize above till asymptotics")
                self.assertEqual(payload["input"], messages)
                self.assertIs(payload["parallel_tool_calls"], False)
                self.assertIs(payload["store"], False)
                self.assertEqual(payload["include"], ["reasoning.encrypted_content"])
                tool, = payload["tools"]
                self.assertEqual((tool["type"], tool["name"], tool["strict"]), ("function", "run_command", True))
                self.assertEqual(tool["parameters"], {
                    "type": "object", "properties": {
                        "argv": {"type": "array", "items": {"type": "string"}, "minItems": 1}},
                    "required": ["argv"], "additionalProperties": False})
                response.read.assert_called_once_with(4 * optimize.CONFIG_LIMIT + 1)
                handler, = build_opener.call_args.args
                self.assertIsNone(handler().redirect_request(request, None, 302, "redirect", {},
                                                             "https://other.example/responses"))

    def test_responses_invalid_endpoint_or_credentials_fail_before_request(self):
        self.record()
        invocation = optimize.discover(self.workspace, self.history)
        cases = [{}, {"OPENAI_API_KEY": "bad key"}, {"OPENAI_API_KEY": "bad\nkey"},
                 {"AZURE_OPENAI_ENDPOINT": "https://example.com", "OPENAI_API_KEY": "no-fallback"}]
        for endpoint in ("http://example.com", "https://user:password@example.com",
                         "https://example.com?api-key=secret", "https://example.com#fragment",
                         "https://example.com/wrong", "https://example .com"):
            cases.append({"AZURE_OPENAI_ENDPOINT": endpoint, "AZURE_OPENAI_API_KEY": "test-key"})
        for env in cases:
            with self.subTest(env=env), mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.object(optimize.urllib.request, "build_opener") as opener:
                with self.assertRaises(optimize.OptimizeError):
                    optimize.ResponsesOptimizer("Optimize prose", invocation, mock.Mock())
                opener.assert_not_called()

    @mock.patch.object(optimize.ResponsesOptimizer, "build", return_value={"exit_code": 0, "output": "Built"})
    def test_responses_invalid_outputs_and_api_errors_fail_not_converge(self, builder):
        self.record()
        (self.project / "objective.md.optim").write_text("Optimize the real score until stable.")
        plan = model_text(json.dumps({"version": 1, "objectives": [self.objective(patience=2)]}))

        def completed(output):
            return json.dumps({"status": "completed", "output": output}).encode()

        cases = [
            ("malformed-json", b"{", "Responses request failed"),
            ("incomplete", json.dumps({"status": "incomplete", "output": model_text("converged")}).encode(),
             "did not complete"),
            ("api-failed", b'{"status":"failed","error":{"message":"provider-secret"}}', "did not complete"),
            ("missing-status", b'{"output":[]}', "did not complete"),
            ("wrong-output", b'{"status":"completed","output":{}}', "did not complete"),
            ("wrong-body", b'[]', "did not complete"),
            ("empty-output", completed([]), "no result"),
            ("empty-text", completed(model_text(" \n")), "no result"),
            ("refusal", completed([{"type": "message", "role": "assistant", "content": [
                {"type": "refusal", "refusal": "Cannot optimize"}]}]), "refused"),
            ("unexpected-output", completed([{"type": "unknown"}]), "Unexpected"),
            ("wrong-tool", completed([{**model_tool(python("pass"))[0], "name": "other"}]), "unsupported tool"),
            ("invalid-arguments", completed([{**model_tool(python("pass"))[0], "arguments": "{"}]), "JSONDecodeError"),
            ("invalid-argv", completed(model_tool("not an argv array")), "bounded argv"),
            ("oversized", b"x" * (4 * optimize.CONFIG_LIMIT + 1), "exceeds 4 MiB"),
            ("http-error", urllib.error.HTTPError("https://example.com/provider-secret", 401,
                                                 "provider-secret", {}, None), "Responses request failed"),
            ("url-error", urllib.error.URLError("provider-secret"), "Responses request failed"),
            ("timeout", TimeoutError("provider-secret"), "Responses request failed"),
        ]
        for phase in ("plan", "step"):
            for name, failure, error in cases:
                logs = self.workspace / f"responses-{phase}-{name}"
                with self.subTest(phase=phase, name=name), \
                        mock.patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=True), \
                        mock.patch.object(optimize.urllib.request, "build_opener") as opener, \
                        contextlib.redirect_stdout(io.StringIO()):
                    response = opener.return_value.open.return_value.__enter__.return_value
                    response.read.side_effect = ([completed(plan)] if phase == "step" else []) + [failure]
                    self.assertEqual(optimize.run(logs, self.workspace, self.history), 1)
                rows = [json.loads(line) for line in (logs / "report.jsonl").read_text().splitlines()]
                self.assertEqual(rows[-1]["outcome"], "failed")
                self.assertIn(error, rows[-1]["error"])
                self.assertNotIn("provider-secret", rows[-1]["error"])
                self.assertEqual([row["outcome"] for row in rows if row["event"] == "final"], ["failed"])
                self.assertEqual(any(row["event"] == "baseline" for row in rows), phase == "step")
                self.assertFalse(any(row["event"] == "iteration" for row in rows))
                self.assertEqual(opener.return_value.open.call_count, 2 if phase == "step" else 1)

    def test_responses_invalid_plan_fails_before_baseline(self):
        self.record()
        (self.project / "objective.md.optim").write_text("Optimize the real score until stable.")
        plans = ["I cannot establish a measurement.", '{"version":1,"objectives":[]}',
                 json.dumps({"version": 1, "objectives": [self.objective(patience=1)]}),
                 json.dumps({"version": 1, "objectives": [self.objective(), self.objective()]})]
        for index, plan in enumerate(plans):
            logs = self.workspace / f"invalid-plan-{index}"
            with self.subTest(plan=plan), \
                    mock.patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=True), \
                    mock.patch.object(optimize.urllib.request, "build_opener") as opener, \
                    contextlib.redirect_stdout(io.StringIO()):
                response = opener.return_value.open.return_value.__enter__.return_value
                response.read.return_value = json.dumps({"status": "completed", "output": model_text(plan)}).encode()
                self.assertEqual(optimize.run(logs, self.workspace, self.history), 1)
            rows = [json.loads(line) for line in (logs / "report.jsonl").read_text().splitlines()]
            self.assertEqual([row["event"] for row in rows], ["start", "model_request", "final"])
            self.assertEqual(rows[-1]["outcome"], "failed")
            opener.return_value.open.assert_called_once()

    @mock.patch.object(optimize.ResponsesOptimizer, "build", return_value={"exit_code": 0, "output": "Built"})
    def test_responses_inspection_or_summary_still_runs_planned_process(self, builder):
        self.record()
        (self.project / "objective.md.optim").write_text("Optimize the real score until stable.")
        command = python("from pathlib import Path; p=Path('attempts'); "
                         "p.write_text(p.read_text()+'x' if p.exists() else 'x')")
        plan = model_text(json.dumps({"version": 1, "objectives": [
            self.objective(command=command, patience=2)]}))
        for inspection in (False, True):
            outputs = [plan]
            for _ in range(2):
                if inspection:
                    outputs.append(model_tool(python("print('inspection only')")))
                outputs.append(model_text("No further improvements; converged."))
            with self.subTest(inspection=inspection), \
                    mock.patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=True), \
                    mock.patch.object(optimize.ResponsesOptimizer, "request", side_effect=outputs), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(optimize.run(self.logs, self.workspace, self.history), 0)
            self.assertEqual((self.project / "attempts").read_text(), "xx")
            (self.project / "attempts").unlink()

    @mock.patch.object(optimize.ResponsesOptimizer, "build", return_value={"exit_code": 0, "output": "Built"})
    def test_responses_validation_must_be_last_successful_tool(self, builder):
        self.record()
        (self.project / "objective.md.optim").write_text("Optimize the real score until stable.")
        edit = python("from pathlib import Path; Path('candidate').write_text('broken')")
        repair = python("from pathlib import Path; Path('candidate').write_text('fixed')")
        inspect = python("print('inspection only')")
        for mode, expected_status, attempts, processes in (
                ("edit", 1, 2, 1), ("edit-and-fail", 1, 3, 1),
                ("failed-rerun", 0, 4, 2), ("inspection", 0, 3, 2),
                ("revalidated", 0, 3, 1), ("last-tool", 0, 2, 1)):
            with self.subTest(mode=mode):
                (self.project / "candidate").write_text("fixed")
                (self.project / "validations").write_text("")
                command = python(
                    "from pathlib import Path; p=Path('validations'); "
                    "p.write_text(p.read_text()+'x'); "
                    "assert Path('candidate').read_text() == 'fixed'; "
                    f"assert not ({mode == 'failed-rerun'!r} and len(p.read_text()) == 2)")
                plan = model_text(json.dumps({"version": 1, "objectives": [
                    self.objective(command=command, patience=2)]}))
                calls = model_tool(command, "validate-first")
                if mode in ("edit", "edit-and-fail", "revalidated"):
                    calls += model_tool(edit, "edit")
                if mode == "revalidated":
                    calls += model_tool(repair, "repair")
                if mode in ("failed-rerun", "edit-and-fail", "revalidated"):
                    calls += model_tool(command, "validate-again")
                if mode == "inspection":
                    calls += model_tool(inspect, "inspect")
                # Exercise both batched tool responses and successive model turns.
                outputs = [plan] + ([calls] if mode == "edit" else [[call] for call in calls])
                outputs += [model_text("Finished; claimed convergence.")]
                if expected_status == 0:
                    outputs += [model_text("No more changes.")]
                logs = self.workspace / f"validation-{mode}"
                with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=True), \
                        mock.patch.object(optimize.ResponsesOptimizer, "request", side_effect=outputs), \
                        contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(optimize.run(logs, self.workspace, self.history), expected_status)
                rows = [json.loads(line) for line in (logs / "report.jsonl").read_text().splitlines()]
                self.assertEqual((self.project / "validations").read_text(), "x" * attempts)
                self.assertEqual(sum(row["event"] == "process" for row in rows), processes)
                self.assertEqual(rows[-1]["outcome"], "failed" if expected_status else "converged")
                if expected_status:
                    self.assertIn("command exited 1", rows[-1]["error"])
                    self.assertFalse(any(row["event"] == "iteration" for row in rows))

    @mock.patch.object(optimize.ResponsesOptimizer, "build", return_value={"exit_code": 0, "output": "Built"})
    def test_responses_failed_tool_can_be_repaired_before_measuring(self, builder):
        self.record()
        (self.project / "objective.md.optim").write_text("Optimize the real score until stable.")
        (self.project / "user-edit").write_text("keep me")
        command = python("from pathlib import Path; assert Path('candidate').read_text() == 'fixed'")
        plan = model_text(json.dumps({"version": 1, "objectives": [
            self.objective(command=command, patience=2)]}))
        outputs = [plan, model_tool(python(
            "from pathlib import Path; Path('candidate').write_text('broken'); print('test failed'); raise SystemExit(1)")),
            model_tool(python("from pathlib import Path; Path('candidate').write_text('fixed')")),
            model_text("Repaired candidate."), model_text("No further improvements.")]
        requests = []

        def request(messages):
            requests.append(json.loads(json.dumps(messages)))
            return outputs.pop(0)

        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=True), \
                mock.patch.object(optimize.ResponsesOptimizer, "request", side_effect=request), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(optimize.run(self.logs, self.workspace, self.history), 0)
        self.assertEqual(json.loads(requests[2][-1]["output"]),
                         {"exit_code": 1, "output": "test failed\n", "truncated": False})
        self.assertEqual((self.project / "user-edit").read_text(), "keep me")
        self.assertEqual((self.project / "candidate").read_text(), "fixed")


if __name__ == "__main__":
    unittest.main()
