import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import uuid

import optimize


def python(code):
    return [sys.executable, "-c", code]


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

    def harness(self, workspace, mode="optimize"):
        workspace.mkdir(exist_ok=True)
        source = Path(optimize.__file__).parent
        payload = Path(optimize.__file__).read_bytes() if mode == "optimize" else b""
        run_id = str(uuid.uuid4())
        child = subprocess.Popen(
            ["bash", "-c", (source / "remote-build.bash").read_text(), "--", str(workspace),
             str(len(payload)), (source / "remote-alias.bash").read_text(),
             (source / "remote-supervisor.bash").read_text(), run_id, "optimization", mode],
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
        child.stdin.write(payload)
        child.stdin.flush()
        return child, workspace / ".spec-runs" / f"run-{run_id}"

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
                   "nohup unknown task &"]
        for attack in attacks:
            self.history.write_text(valid + attack + "\n")
            with self.subTest(attack=attack), mock.patch.object(optimize.subprocess, "Popen") as popen:
                with self.assertRaises(optimize.OptimizeError):
                    optimize.discover(self.workspace, self.history)
                popen.assert_not_called()
        self.assertFalse((self.workspace / "OWNED").exists())

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
        with self.assertRaisesRegex(optimize.OptimizeError, "cannot order"):
            optimize.discover(self.workspace, self.history)

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
        self.config([self.objective(command=python(code) + ["$(touch OWNED)"], patience=2)])
        snapshot = self.workspace / "snapshot.md"
        snapshot.write_bytes(Path(optimize.__file__).read_bytes())
        result = subprocess.run([sys.executable, "-u", str(snapshot), str(self.logs), str(self.workspace)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
                                env={**os.environ, "HOME": str(self.workspace)})
        self.assertEqual(result.returncode, 0, result.stderr.decode() + result.stdout.decode())
        self.assertFalse((self.project / "OWNED").exists())
        self.assertEqual(json.loads(result.stdout.splitlines()[-1])["outcome"], "converged")


if __name__ == "__main__":
    unittest.main()
