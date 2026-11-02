#!/usr/bin/env python3
"""Trusted, explicit-project dataset evaluation and offline Candle training."""

import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import sys

import optimize


DATASET_HELPER = """
import importlib.util, json, pathlib, sys
root, request, output = map(pathlib.Path, sys.argv[1:])
sys.path.insert(0, str(root / 'spec-training'))
spec = importlib.util.spec_from_file_location('environment', root / 'spec-training/environment.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result = module.evaluate_directory(**json.loads(request.read_text(encoding='utf-8')))
with output.open('x', encoding='utf-8') as handle:
    json.dump(result, handle, allow_nan=False)
"""


def require(condition, message):
    if not condition:
        raise optimize.OptimizeError(message)


def text(value, label):
    require(isinstance(value, str) and bool(value.strip()) and value.isprintable(),
            f"{label} must be nonempty printable text (no control characters)")
    return value


def number(value, label, lower=0, upper=None):
    require(type(value) in (int, float) and math.isfinite(value)
            and value >= lower and (upper is None or value <= upper), f"invalid {label}")
    return value


def load_json(path=None, content=None):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, f"duplicate JSON key: {key}")
            result[key] = value
        return result

    def finite(value):
        result = float(value)
        require(math.isfinite(result), "JSON numbers must be finite")
        return result

    raw = optimize.read_limited(path, optimize.CONFIG_LIMIT) if content is None else content
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    require(len(raw) <= optimize.CONFIG_LIMIT, "JSON exceeds 1 MiB")
    return json.loads(raw, object_pairs_hook=unique, parse_float=finite, parse_constant=finite)


def fields(value, required, optional=()):
    require(isinstance(value, dict) and set(required) <= value.keys()
            and not value.keys() - set(required) - set(optional),
            f"expected fields {sorted(required)}; optional {sorted(optional)}")


def directory(base, value, label, contained=False):
    path = Path(text(value, label))
    if contained:
        require(not path.is_absolute() and ".." not in path.parts,
                f"{label} must be project-relative without traversal")
    resolved = (base / path).resolve(strict=True)
    require(resolved.is_dir(), f"{label} must be an existing directory")
    if contained:
        require(resolved.is_relative_to(base), f"{label} escapes project")
    return resolved


def configuration(workspace, request):
    fields(request, {"project", "spec"})
    workspace = Path(workspace).resolve(strict=True)
    require(workspace.is_dir(), "WORKSPACE must be a directory")
    # Relative projects stay in the workspace; outside projects require an explicit absolute path.
    project_value = text(request["project"], "project")
    project = directory(workspace, project_value, "project", not Path(project_value).is_absolute())
    upload = request["spec"]
    if upload is None:
        source = str(project / "performance.json")
        require(Path(source).is_file(), f"missing {source}; supply a trusted performance.json or editor JSON manifest")
        manifest = load_json(Path(source))
    else:
        fields(upload, {"name", "content"})
        source = text(upload["name"], "spec.name")
        require(isinstance(upload["content"], str), "spec.content must be JSON text")
        manifest = load_json(content=upload["content"])
    fields(manifest, {"pipeline_root", "dataset", "model"})
    root = directory(project, manifest["pipeline_root"], "pipeline_root")
    require((root / "spec-training/environment.py").is_file(), "pipeline_root lacks spec-training/environment.py")
    dataset = manifest["dataset"]
    fields(dataset, {"source_dir", "editable_files", "test_commands", "image"},
           {"replacements", "timeout_seconds"})
    dataset = dict(dataset)
    dataset["source_dir"] = str(directory(project, dataset["source_dir"], "source_dir", True))
    dataset.setdefault("replacements", {})
    dataset.setdefault("timeout_seconds", 10)
    number(dataset["timeout_seconds"], "dataset.timeout_seconds", 0, 300)
    require(dataset["timeout_seconds"] > 0, "dataset.timeout_seconds must be positive")
    require(isinstance(dataset["editable_files"], list) and bool(dataset["editable_files"]),
            "editable_files must be a nonempty array")
    for name in dataset["editable_files"]:
        text(name, "editable file")
        require(not name.startswith("/") and "\\" not in name
                and all(part not in ("", ".", "..") for part in name.split("/")), "invalid editable file path")
    require(len(set(dataset["editable_files"])) == len(dataset["editable_files"]), "duplicate editable file")
    require(isinstance(dataset["replacements"], dict) and all(
        name in dataset["editable_files"] and isinstance(value, str)
        for name, value in dataset["replacements"].items()), "invalid replacements")
    commands = dataset["test_commands"]
    require(isinstance(commands, list) and 1 <= len(commands) <= 32, "expected 1..32 test_commands")
    for argv in commands:
        require(isinstance(argv, list) and 1 <= len(argv) <= 256, "test_commands must contain argv arrays")
        require(all(isinstance(arg, str) and "\0" not in arg for arg in argv)
                and bool(argv[0]) and not argv[0].startswith("-"), "invalid test argv")
    require(isinstance(dataset["image"], str) and re.fullmatch(
        r"[a-zA-Z0-9./:_-]+@sha256:[0-9a-f]{64}", dataset["image"]), "image must be digest-pinned")
    model = manifest["model"]
    fields(model, {"binary", "args"}, {"timeout_seconds"})
    model = dict(model)
    binary = (project / text(model["binary"], "model.binary")).resolve(strict=True)
    require(binary.is_file() and os.access(binary, os.X_OK), "model.binary must be a prebuilt executable")
    model["binary"] = str(binary)
    args = model["args"]
    require(isinstance(args, list) and 1 <= len(args) <= 256, "model.args must be a nonempty argv array")
    require(all(isinstance(arg, str) and "\0" not in arg for arg in args)
            and sum(map(len, args)) <= 65536, "invalid model argv")
    require(args[0].startswith("--") and all(arg != "--" and arg.split("=", 1)[0] != "--output"
            for arg in args), "model.args must omit the train subcommand, -- separator, and --output")
    model.setdefault("timeout_seconds", 3600)
    number(model["timeout_seconds"], "model.timeout_seconds", 0, 86400)
    require(model["timeout_seconds"] > 0, "model.timeout_seconds must be positive")
    return project, source, root, dataset, model


def dataset_metrics(path, count):
    metrics = load_json(path)
    fields(metrics, {"score", "tests", "snapshot_sha256"})
    number(metrics["score"], "dataset score", 0, 1)
    tests = metrics["tests"]
    require(isinstance(tests, list) and len(tests) == count and count > 0
            and all(test in ("pass", "fail", "timeout", "killed") for test in tests), "invalid dataset tests")
    require(metrics["score"] == tests.count("pass") / count, "dataset score disagrees with test outcomes")
    require(isinstance(metrics["snapshot_sha256"], str)
            and re.fullmatch(r"[0-9a-f]{64}", metrics["snapshot_sha256"]), "invalid dataset snapshot hash")
    return metrics


def model_metrics(output):
    report = load_json(output / "report.json")
    fields(report, {"before", "after", "benchmark", "validation_nll_plateau",
                    "validation_nll_improved", "convergence_scope", "policy_value_scope"})
    for phase in ("before", "after"):
        metrics = report[phase]
        fields(metrics, {"accuracy", "mean_nll", "trajectory_exact_match", "per_trajectory_accuracy", "predictions"})
        for key in ("accuracy", "trajectory_exact_match"):
            number(metrics[key], f"{phase}.{key}", 0, 1)
        number(metrics["mean_nll"], f"{phase}.mean_nll")
        for key in ("per_trajectory_accuracy", "predictions"):
            values = metrics[key]
            require(isinstance(values, dict) and bool(values), f"empty or invalid {phase}.{key}")
            for name, value in values.items():
                text(name, key)
                if key == "predictions":
                    require(type(value) is int and value >= 0, "invalid predicted action")
                else:
                    number(value, key, 0, 1)
    for key in ("predictions", "per_trajectory_accuracy"):
        require(report["before"][key].keys() == report["after"][key].keys(), "model evaluation IDs changed")
    for key in ("validation_nll_plateau", "validation_nll_improved"):
        require(type(report[key]) is bool, f"invalid {key}")
    require(report["validation_nll_improved"] == (report["after"]["mean_nll"] < report["before"]["mean_nll"]),
            "inconsistent validation_nll_improved")
    for key in ("convergence_scope", "policy_value_scope"):
        text(report[key], key)
    benchmark = report["benchmark"]
    require(isinstance(benchmark, dict) and bool(benchmark), "invalid benchmark")
    if benchmark.get("status") == "not_run":
        fields(benchmark, {"status", "reason"})
        text(benchmark["reason"], "benchmark reason")
    else:
        fields(benchmark, {"baseline", "student", "paired_accuracy_difference", "bootstrap", "scope"})
        require(benchmark["student"] == report["after"], "benchmark student differs from final evaluation")
        baseline = benchmark["baseline"]
        fields(baseline, {"accuracy", "trajectory_exact_match", "per_trajectory_accuracy", "predictions", "model", "revision"})
        require(baseline["model"] == "GPT-sol", "invalid baseline model")
        text(baseline["revision"], "baseline revision")
        number(baseline["accuracy"], "baseline accuracy", 0, 1)
        number(baseline["trajectory_exact_match"], "baseline exact match", 0, 1)
        for key in ("predictions", "per_trajectory_accuracy"):
            require(isinstance(baseline[key], dict) and baseline[key].keys() == report["after"][key].keys(),
                    "baseline evaluation IDs differ")
            for value in baseline[key].values():
                number(value, f"baseline {key}", 0, 1 if key == "per_trajectory_accuracy" else None)
                if key == "predictions":
                    require(type(value) is int, "invalid baseline action")
        difference = number(benchmark["paired_accuracy_difference"], "paired accuracy difference", -1, 1)
        require(math.isclose(difference, report["after"]["accuracy"] - baseline["accuracy"], abs_tol=1e-12),
                "inconsistent benchmark difference")
        bootstrap = benchmark["bootstrap"]
        fields(bootstrap, {"ci_lower", "ci_upper", "confidence_level", "groups", "method", "resamples", "seed", "unit", "warning"})
        for key in ("ci_lower", "ci_upper"):
            number(bootstrap[key], key, -1, 1)
        require(bootstrap["ci_lower"] <= bootstrap["ci_upper"], "invalid confidence interval")
        number(bootstrap["confidence_level"], "confidence_level", 0, 1)
        for key in ("groups", "resamples", "seed"):
            require(type(bootstrap[key]) is int and bootstrap[key] >= (0 if key == "seed" else 1), f"invalid {key}")
        for key in ("method", "unit"):
            text(bootstrap[key], key)
        require(bootstrap["warning"] is None or isinstance(bootstrap["warning"], str), "invalid bootstrap warning")
        text(benchmark["scope"], "benchmark scope")
    checkpoint = output / "student.safetensors"
    require(not checkpoint.is_symlink() and stat.S_ISREG(checkpoint.stat().st_mode)
            and checkpoint.stat().st_size > 8, "missing or empty model checkpoint")
    # Check the bounded safetensors header and payload layout without loading weights into RAM.
    with checkpoint.open("rb") as handle:
        size = int.from_bytes(handle.read(8), "little")
        require(0 < size <= optimize.CONFIG_LIMIT, "invalid checkpoint header size")
        header = load_json(content=handle.read(size))
    require(isinstance(header, dict), "invalid checkpoint header")
    offsets = []
    for name, tensor in header.items():
        if name == "__metadata__":
            continue
        fields(tensor, {"dtype", "shape", "data_offsets"})
        shape, bounds = tensor["shape"], tensor["data_offsets"]
        require(tensor["dtype"] == "F32" and isinstance(shape, list)
                and all(type(n) is int and n >= 0 for n in shape), "invalid checkpoint tensor")
        require(isinstance(bounds, list) and len(bounds) == 2
                and all(type(n) is int and n >= 0 for n in bounds)
                and bounds[1] - bounds[0] == math.prod(shape) * 4, "invalid checkpoint offsets")
        offsets.append(bounds)
    require(bool(offsets), "checkpoint contains no tensors")
    end = 0
    for start, stop in sorted(offsets):
        require(start == end, "checkpoint payload has holes or overlaps")
        end = stop
    require(end > 0 and checkpoint.stat().st_size == 8 + size + end, "truncated or invalid checkpoint payload")
    return report


def model_summary(report):
    # Per-step maps remain in report.json, never in the bounded UI/recovery tail.
    scalar_keys = ("accuracy", "mean_nll", "trajectory_exact_match")
    result = {phase: {key: report[phase][key] for key in scalar_keys}
              for phase in ("before", "after")}
    for key in ("validation_nll_plateau", "validation_nll_improved"):
        result[key] = report[key]
    for key in ("convergence_scope", "policy_value_scope"):
        result[key] = report[key][:1024]
    benchmark = report["benchmark"]
    if benchmark.get("status") == "not_run":
        result["benchmark"] = {"status": "not_run", "reason": benchmark["reason"][:1024]}
    else:
        result["benchmark"] = {
            "baseline": {key: benchmark["baseline"][key] for key in ("accuracy", "trajectory_exact_match", "model")},
            "paired_accuracy_difference": benchmark["paired_accuracy_difference"],
            "bootstrap": {key: value[:1024] if isinstance(value, str) else value
                          for key, value in benchmark["bootstrap"].items()},
            "scope": benchmark["scope"][:1024],
        }
        result["benchmark"]["baseline"]["revision"] = benchmark["baseline"]["revision"][:1024]
    return result


def run(run_directory, workspace, request_config_path):
    run_directory = Path(run_directory).resolve()
    reporter = optimize.Reporter(run_directory)
    target = {"project": None, "spec": None}
    results = {}
    artifacts = {}
    stage = "configuration"
    try:
        project, source, root, dataset, model = configuration(workspace, load_json(Path(request_config_path)))
        target.update(project=str(project), spec=source)
        with optimize.project_lock(project, Path(workspace).resolve()):
            # A run ID is single-use, including after cancellation or partial failure.
            (run_directory / "performance-state").mkdir(mode=0o700)
            for name in ("model", "dataset-metrics.json", "dataset-request.json"):
                require(not os.path.lexists(run_directory / name), f"stale performance artifact: {name}")
            reporter.emit("start", **target, pipeline_root=str(root))
            invocation = optimize.Invocation(project, source, run_directory / "progress.log", "performance")
            request_path = run_directory / "dataset-request.json"
            with request_path.open("x", encoding="utf-8") as handle:
                json.dump(dataset, handle, allow_nan=False)
            stage = "dataset_pipe"
            reporter.emit("stage_start", stage=stage)
            optimize.execute([sys.executable, "-I", "-B", "-c", DATASET_HELPER, str(root), str(request_path),
                              str(run_directory / "dataset-metrics.json")], invocation,
                             {"name": stage, "timeout_seconds": 60 + len(dataset["test_commands"]) *
                              (dataset["timeout_seconds"] + 35)}, 0, "command", reporter)
            results[stage] = dataset_metrics(run_directory / "dataset-metrics.json", len(dataset["test_commands"]))
            artifacts[stage] = str(run_directory / "dataset-metrics.json")
            reporter.emit("stage_metrics", stage=stage, metrics=results[stage], artifact=artifacts[stage])
            stage = "model_pipeline"
            output = run_directory / "model"
            reporter.emit("stage_start", stage=stage)
            optimize.execute([model["binary"], "train", *model["args"], "--output", str(output)], invocation,
                             {"name": stage, "timeout_seconds": model["timeout_seconds"]}, 0, "command", reporter)
            require(not output.is_symlink() and not (output / "report.json").is_symlink(), "model artifacts must not be symlinks")
            results[stage] = model_summary(model_metrics(output))
            artifacts[stage] = str(output / "report.json")
            reporter.emit("stage_metrics", stage=stage, metrics=results[stage], artifact=artifacts[stage])
            reporter.emit("final", outcome="completed", stage=stage, **target, metrics=results, artifacts=artifacts)
        return 0
    except KeyboardInterrupt:
        reporter.emit("final", outcome="interrupted", stage=stage, **target, metrics=results, artifacts=artifacts)
        return 130
    except Exception as error:
        reporter.emit("final", outcome="failed", stage=stage, **target, metrics=results, artifacts=artifacts,
                      error=f"{type(error).__name__}: {error}")
        return 1
    finally:
        reporter.close()


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--supervise":
        return optimize.supervise_command(sys.argv[2:])
    if len(sys.argv) != 4:
        print("usage: python3 -u snapshot.md RUN_DIRECTORY WORKSPACE REQUEST_CONFIG_PATH", file=sys.stderr)
        return 2

    def interrupted(signum, frame):
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        return run(*sys.argv[1:])
    except (OSError, KeyboardInterrupt) as error:
        print(f"performance could not write reports: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
