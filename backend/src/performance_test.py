"""Runner tests; Docker protocol stubs are explicit, never a production fallback."""

from contextlib import redirect_stdout
import copy
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
from unittest.mock import patch

import optimize
import performance


PIPELINE = Path(os.environ.get("PERFORMANCE_TEST_PIPELINE_ROOT", "/home/opencode/project"))
BINARY = PIPELINE / "candle/target/debug/examples/gemma4-distill"
FIXTURES = PIPELINE / "candle/candle-examples/examples/gemma4-distill/fixtures"


def report_fixture():
    metrics = {"accuracy": 0.5, "mean_nll": 0.7, "trajectory_exact_match": 0.5,
               "per_trajectory_accuracy": {"episode": 0.5}, "predictions": {"step": 0}}
    return {"before": copy.deepcopy(metrics), "after": copy.deepcopy(metrics),
            "benchmark": {"status": "not_run", "reason": "no GPT-sol prediction artifact supplied"},
            "validation_nll_improved": False, "validation_nll_plateau": False,
            "convergence_scope": "Not a convergence proof", "policy_value_scope": "Logged action agreement only"}


def write_model(output, report=None):
    output.mkdir()
    (output / "report.json").write_text(json.dumps(report_fixture() if report is None else report))
    header = json.dumps({"weight": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}).encode()
    (output / "student.safetensors").write_bytes(len(header).to_bytes(8, "little") + header + b"\0" * 4)


class PerformanceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="performance-test-", dir="/tmp/opencode")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.project = self.root / "project with spaces;literal"
        self.project.mkdir()
        self.source = self.project / "curated"
        self.source.mkdir()
        (self.source / "solution.py").write_text("answer = 42\n")
        self.pipeline = self.root / "pipelines"
        (self.pipeline / "spec-training").mkdir(parents=True)
        (self.pipeline / "spec-training/environment.py").write_text("raise RuntimeError('unit tests must mock execute')\n")
        self.run_dir = self.root / "run"
        self.request_path = self.root / "request.json"
        self.manifest = {"pipeline_root": str(self.pipeline),
                         "dataset": {"source_dir": "curated", "editable_files": ["solution.py"],
                                     "test_commands": [["python3", "-B", "solution.py"]],
                                     "image": "local/test@sha256:" + "a" * 64},
                         "model": {"binary": sys.executable, "args": ["--from-scratch"]}}
        self.request = {"project": self.project.name, "spec": None}
        self.calls = []
        self.clean_environment = patch.dict(os.environ)
        self.clean_environment.start()
        self.addCleanup(self.clean_environment.stop)
        for key in ("SPEC_EXECUTION_PROFILE", "SPEC_OPTIM_WORKSPACE_LOCK"):
            os.environ.pop(key, None)

    def save(self):
        (self.project / "performance.json").write_text(json.dumps(self.manifest))
        self.request_path.write_text(json.dumps(self.request))

    def execute_fixture(self, argv, invocation, objective, iteration, phase, reporter):
        self.calls.append((argv, invocation, objective, phase))
        if objective["name"] == "dataset_pipe":
            Path(argv[-1]).write_text(json.dumps({"score": 1, "tests": ["pass"], "snapshot_sha256": "a" * 64}))
        else:
            write_model(Path(argv[-1]))

    def run_fixture(self, execute=None):
        self.save()
        with redirect_stdout(io.StringIO()), patch.object(optimize, "execute", side_effect=execute or self.execute_fixture), \
                patch.object(optimize, "discover", side_effect=AssertionError("must not discover")):
            status = performance.run(self.run_dir, self.root, self.request_path)
        records = [json.loads(line) for line in (self.run_dir / "report.jsonl").read_text().splitlines()]
        return status, records

    def test_success_metrics_lock_and_exact_argv(self):
        with patch.object(optimize, "project_lock", wraps=optimize.project_lock) as lock:
            status, records = self.run_fixture()
        self.assertEqual(status, 0)
        lock.assert_called_once_with(self.project, self.root)
        self.assertEqual([record["event"] for record in records],
                         ["start", "stage_start", "stage_metrics", "stage_start", "stage_metrics", "final"])
        final = records[-1]
        self.assertEqual(final["outcome"], "completed")
        self.assertEqual(final["metrics"]["dataset_pipe"]["score"], 1)
        self.assertFalse(final["metrics"]["model_pipeline"]["validation_nll_improved"])
        argv, invocation, objective, phase = self.calls[0]
        self.assertEqual(argv[:4], [sys.executable, "-I", "-B", "-c"])
        self.assertEqual(invocation.project, self.project)
        self.assertEqual(objective["timeout_seconds"], 105)
        self.assertEqual(phase, "command")
        self.assertEqual(self.calls[1][0], [str(Path(sys.executable).resolve()), "train", "--from-scratch",
                                           "--output", str(self.run_dir / "model")])
        normalized = json.loads((self.run_dir / "dataset-request.json").read_text())
        self.assertEqual(normalized["replacements"], {})
        self.assertEqual(normalized["source_dir"], str(self.source))
        self.assertEqual((self.run_dir / "progress.log").read_text(), (self.run_dir / "report.jsonl").read_text())

    def test_extension_free_upload_overrides_project_manifest(self):
        self.request["spec"] = {"name": "manifest without extension", "content": json.dumps(self.manifest)}
        self.manifest = {"invalid": "ignored"}
        status, records = self.run_fixture()
        self.assertEqual(status, 0)
        self.assertEqual(records[-1]["spec"], "manifest without extension")
        self.assertFalse((self.project / "manifest without extension").exists())

    def test_large_model_report_keeps_summary_and_artifacts_in_recovery_tail(self):
        report = report_fixture()
        for phase in ("before", "after"):
            report[phase]["predictions"] = {f"step-{i:05}": 0 for i in range(12000)}

        def execute(*args):
            if args[2]["name"] == "model_pipeline":
                write_model(self.run_dir / "model", report)
            else:
                self.execute_fixture(*args)

        status, records = self.run_fixture(execute)
        self.assertEqual(status, 0)
        self.assertGreater((self.run_dir / "model/report.json").stat().st_size, 256 * 1024)
        final = records[-1]
        self.assertLess(len(json.dumps(final).encode()), 16 * 1024)
        for phase in ("before", "after"):
            self.assertEqual(final["metrics"]["model_pipeline"][phase]["mean_nll"], 0.7)
            self.assertNotIn("predictions", final["metrics"]["model_pipeline"][phase])
        self.assertEqual(final["metrics"]["dataset_pipe"]["score"], 1)
        self.assertEqual(set(final["artifacts"]), {"dataset_pipe", "model_pipeline"})
        tail = (self.run_dir / "progress.log").read_bytes()[-256 * 1024:]
        self.assertEqual(json.loads(tail.splitlines()[-1]), final)

    def test_missing_manifest(self):
        self.request_path.write_text(json.dumps(self.request))
        with redirect_stdout(io.StringIO()), patch.object(optimize, "execute") as execute:
            self.assertEqual(performance.run(self.run_dir, self.root, self.request_path), 1)
        execute.assert_not_called()
        self.assertIn("missing", (self.run_dir / "report.jsonl").read_text())

    def test_project_resolution_and_rejections(self):
        self.save()
        for value in (self.project.name, "./" + self.project.name, str(self.project)):
            with self.subTest(value=value):
                self.request["project"] = value
                self.assertEqual(performance.configuration(self.root, self.request)[0], self.project)
        outside = self.root / "outside-link"
        outside.symlink_to(self.root.parent, target_is_directory=True)
        for value in ("../" + self.root.name, "outside-link", "bad\npath", "bad\0path", "", 42):
            with self.subTest(value=value), self.assertRaises((optimize.OptimizeError, OSError)):
                performance.configuration(self.root, {"project": value, "spec": None})

    def test_manifest_rejects_traversal_output_override_and_invalid_schema(self):
        original = copy.deepcopy(self.manifest)
        cases = [("dataset", "source_dir", "../curated"), ("dataset", "source_dir", str(self.source)),
                 ("dataset", "editable_files", ["../solution.py"]), ("dataset", "image", "latest"),
                 ("dataset", "test_commands", []), ("dataset", "replacements", {"other.py": "x"}),
                 ("dataset", "timeout_seconds", 0), ("model", "timeout_seconds", True),
                 ("model", "args", ["train"]), ("model", "args", ["--output=x"]),
                 ("model", "args", ["--output", "x"]), ("model", "args", ["--", "x"]),
                 ("model", "args", ["--config", "a\0b"]), ("model", "binary", "/missing-binary")]
        for section, key, value in cases:
            with self.subTest(section=section, key=key, value=value):
                self.manifest = copy.deepcopy(original)
                self.manifest[section][key] = value
                self.save()
                with self.assertRaises((optimize.OptimizeError, OSError)):
                    performance.configuration(self.root, self.request)

    def test_json_is_bounded_unique_and_finite(self):
        for raw in ('{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}', '{"a":1e999}',
                    ' ' * (optimize.CONFIG_LIMIT + 1), '"' + '\u00e9' * optimize.CONFIG_LIMIT + '"'):
            with self.subTest(raw=raw[:30]), self.assertRaises(optimize.OptimizeError):
                performance.load_json(content=raw)

    def test_stage_failure_and_cancellation_keep_only_completed_metrics(self):
        for stage in ("dataset_pipe", "model_pipeline"):
            for error, expected in ((optimize.OptimizeError("child failed"), 1), (KeyboardInterrupt(), 130)):
                with self.subTest(stage=stage, expected=expected):
                    self.run_dir = self.root / (stage + str(expected))

                    def execute(*args):
                        if args[2]["name"] == stage:
                            raise error
                        self.execute_fixture(*args)

                    status, records = self.run_fixture(execute)
                    self.assertEqual(status, expected)
                    self.assertEqual(set(records[-1]["metrics"]), set() if stage == "dataset_pipe" else {"dataset_pipe"})
                    self.assertEqual(records[-1]["stage"], stage)

    def test_missing_report_or_checkpoint_never_succeeds(self):
        for missing in ("report.json", "student.safetensors"):
            with self.subTest(missing=missing):
                self.run_dir = self.root / missing

                def execute(*args):
                    self.execute_fixture(*args)
                    if args[2]["name"] == "model_pipeline":
                        (self.run_dir / "model" / missing).unlink()

                status, records = self.run_fixture(execute)
                self.assertEqual(status, 1)
                self.assertEqual(set(records[-1]["metrics"]), {"dataset_pipe"})

    def test_stale_artifacts_and_reused_run_are_rejected(self):
        self.run_dir.mkdir()
        write_model(self.run_dir / "model")
        status, records = self.run_fixture()
        self.assertEqual(status, 1)
        self.assertIn("stale", records[-1]["error"])
        self.assertEqual(self.calls, [])
        self.run_dir = self.root / "fresh"
        self.assertEqual(self.run_fixture()[0], 0)
        self.calls.clear()
        self.assertEqual(self.run_fixture()[0], 1)
        self.assertEqual(self.calls, [])

    def test_invalid_dataset_metrics(self):
        path = self.root / "metrics.json"
        valid = {"score": 0, "tests": ["fail"], "snapshot_sha256": "a" * 64}
        path.write_text(json.dumps(valid))
        self.assertEqual(performance.dataset_metrics(path, 1), valid)
        for key, value in (("score", 1), ("score", float("nan")), ("score", True),
                           ("tests", []), ("tests", ["unknown"]), ("snapshot_sha256", "")):
            with self.subTest(key=key, value=value):
                path.write_text(json.dumps({**valid, key: value}))
                with self.assertRaises(optimize.OptimizeError):
                    performance.dataset_metrics(path, 1)

    def test_invalid_model_reports_and_checkpoint(self):
        output = self.root / "output"
        write_model(output)
        self.assertEqual(performance.model_metrics(output), report_fixture())
        for key, value in (("before", {}), ("after", {**report_fixture()["after"], "mean_nll": None}),
                           ("after", {**report_fixture()["after"], "accuracy": float("inf")}),
                           ("after", {**report_fixture()["after"], "predictions": {}}),
                           ("benchmark", {}), ("validation_nll_plateau", 1), ("validation_nll_improved", True)):
            with self.subTest(key=key, value=value):
                (output / "report.json").write_text(json.dumps({**report_fixture(), key: value}))
                with self.assertRaises(optimize.OptimizeError):
                    performance.model_metrics(output)
        (output / "report.json").write_text(json.dumps(report_fixture()))
        for data in (b"", b"not a checkpoint", (100).to_bytes(8, "little") + b"{}"):
            (output / "student.safetensors").write_bytes(data)
            with self.assertRaises((optimize.OptimizeError, ValueError)):
                performance.model_metrics(output)

    def test_main_supervisor_forwarding_and_usage(self):
        with patch.object(sys, "argv", ["snapshot.md", "--supervise", "tool", "arg"]), \
                patch.object(optimize, "supervise_command", return_value=7) as supervise:
            self.assertEqual(performance.main(), 7)
            supervise.assert_called_once_with(["tool", "arg"])
        with patch.object(sys, "argv", ["snapshot.md"]), patch("sys.stderr", io.StringIO()):
            self.assertEqual(performance.main(), 2)

    def test_embedded_snapshot_and_extension_free_upload_without_local_manifest(self):
        snapshot = self.root / "snapshot.md"
        # Reproduce the backend bootstrap: the embedded optimizer supervises via this same snapshot.
        snapshot.write_text(
            "import sys, types\n"
            "module = types.ModuleType('optimize')\n"
            "module.__file__ = __file__\n"
            "sys.modules['optimize'] = module\n"
            f"exec(compile({Path(optimize.__file__).read_text()!r}, __file__, 'exec'), module.__dict__)\n"
            + Path(performance.__file__).read_text())
        (self.pipeline / "spec-training/environment.py").write_text(
            "def evaluate_directory(**kwargs):\n"
            "    return {'score': 0, 'tests': ['fail'], 'snapshot_sha256': 'a' * 64}\n")
        # A real child that exits zero without artifacts must fail even inside the embedded runner.
        self.manifest["model"]["binary"] = "/bin/true"
        self.request["spec"] = {"name": "extension-free", "content": json.dumps(self.manifest)}
        self.request_path.write_text(json.dumps(self.request))
        result = subprocess.run([sys.executable, "-I", "-B", str(snapshot), str(self.run_dir),
                                 str(self.root), str(self.request_path)], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        records = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(records[-1]["stage"], "model_pipeline")
        self.assertEqual(records[-1]["spec"], "extension-free")
        self.assertEqual(records[-1]["metrics"]["dataset_pipe"]["score"], 0)
        self.assertIn("report.json", records[-1]["error"])

    @unittest.skipUnless((PIPELINE / "spec-training/environment.py").is_file() and BINARY.is_file(),
                         "actual environment.py and prebuilt gemma4-distill required")
    def test_real_pipeline_with_explicit_docker_stub(self):
        stub_dir = self.root / "docker-stub"
        stub_dir.mkdir()
        docker = stub_dir / "docker"
        docker.write_text(f"#!{sys.executable}\nimport os, sys\n"
                          "if sys.argv[1] == 'run':\n"
                          "    sys.exit(int(os.environ.get('TEST_DOCKER_EXIT', '0')))\n")
        docker.chmod(0o755)
        self.manifest["pipeline_root"] = str(PIPELINE)
        self.manifest["model"] = {"binary": str(BINARY), "args": [
            "--config", str(FIXTURES / "config.json"), "--train-data", str(FIXTURES / "train.json"),
            "--validation-data", str(FIXTURES / "validation.json"), "--gpt-sol-predictions", str(FIXTURES / "gpt-sol.json"),
            "--teacher-model", "synthetic-teacher", "--teacher-revision", "synthetic-fixture-v1",
            "--teacher-parameters", "1000000", "--from-scratch", "--epochs", "1"], "timeout_seconds": 60}
        # These files would execute if the runner imported project Python or used a host-test fallback.
        (self.project / "environment.py").write_text("raise AssertionError('project import')\n")
        (self.source / "solution.py").write_text("raise AssertionError('no host execution')\n")
        self.save()
        env = {**os.environ, "PATH": str(stub_dir) + os.pathsep + os.environ["PATH"]}
        for docker_status in (0, 1, 125):
            with self.subTest(docker_status=docker_status):
                run_dir = self.root / f"actual-{docker_status}"
                process = subprocess.run([sys.executable, "-B", str(Path(performance.__file__)), str(run_dir),
                                          str(self.root), str(self.request_path)], capture_output=True, text=True,
                                         env={**env, "TEST_DOCKER_EXIT": str(docker_status)}, timeout=90)
                self.assertEqual(process.returncode, 1 if docker_status == 125 else 0, process.stdout + process.stderr)
                records = [json.loads(line) for line in process.stdout.splitlines()]
                final = records[-1]
                if docker_status == 125:
                    self.assertEqual(final["metrics"], {})
                    self.assertFalse((run_dir / "model").exists())
                else:
                    self.assertEqual(final["metrics"]["dataset_pipe"]["score"], 1 if docker_status == 0 else 0)
                    self.assertGreater((run_dir / "model/student.safetensors").stat().st_size, 1000)
                    self.assertIn("mean_nll", final["metrics"]["model_pipeline"]["after"])
                    self.assertIn("epoch=1", (run_dir / "commands.log").read_text())

    def test_real_child_failure_timeout_and_bounded_logs(self):
        self.run_dir.mkdir()
        reporter = optimize.Reporter(self.run_dir)
        self.addCleanup(reporter.close)
        invocation = optimize.Invocation(self.project, "performance.json", self.run_dir / "progress.log", "test")
        with self.assertRaisesRegex(optimize.OptimizeError, "exited 9"):
            optimize.execute([sys.executable, "-c", "raise SystemExit(9)"], invocation,
                             {"name": "model_pipeline", "timeout_seconds": 5}, 0, "command", reporter)
        with self.assertRaisesRegex(optimize.OptimizeError, "timeout"):
            optimize.execute([sys.executable, "-c", "import time; time.sleep(20)"], invocation,
                             {"name": "model_pipeline", "timeout_seconds": 0.2}, 0, "command", reporter)
        with patch.object(optimize, "COMMAND_LOG_LIMIT", 512):
            optimize.execute([sys.executable, "-c", "print('x' * 100000)"], invocation,
                             {"name": "model_pipeline", "timeout_seconds": 5}, 0, "command", reporter)
        self.assertLessEqual((self.run_dir / "commands.log").stat().st_size, 512)

    def test_cli_sigterm_records_interruption_and_reaps_child(self):
        binary = self.root / "slow-model"
        pidfile = self.root / "child.pid"
        binary.write_text(f"#!{sys.executable}\nimport os, pathlib, time\n"
                          f"pathlib.Path({str(pidfile)!r}).write_text(str(os.getpid()))\n"
                          "time.sleep(60)\n")
        binary.chmod(0o755)
        # Explicit unit-test pipeline substitute; the separate integration test uses the real module.
        (self.pipeline / "spec-training/environment.py").write_text(
            "def evaluate_directory(**kwargs):\n"
            "    return {'score': 1, 'tests': ['pass'], 'snapshot_sha256': 'a' * 64}\n")
        self.manifest["model"]["binary"] = str(binary)
        self.save()
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen([sys.executable, "-B", str(Path(performance.__file__)), str(self.run_dir),
                                        str(self.root), str(self.request_path)], stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 10
                while not pidfile.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(pidfile.exists())
                process.send_signal(signal.SIGTERM)
                self.assertEqual(process.wait(timeout=10), 130)
                with self.assertRaises(ProcessLookupError):
                    os.kill(int(pidfile.read_text()), 0)
                final = json.loads((self.run_dir / "report.jsonl").read_text().splitlines()[-1])
                self.assertEqual(final["outcome"], "interrupted")
                self.assertEqual(set(final["metrics"]), {"dataset_pipe"})
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
