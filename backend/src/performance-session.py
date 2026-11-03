#!/usr/bin/env python3
"""Run the existing Gemma RL implementation in a fresh, supervised builder session."""

import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys


LIMIT = 1024 * 1024
PROMPT = """Run the already-built Gemma Reinforcement Learning implementation (gemma4-policy),
not the distillation pipeline. This is an independent Performance execution, not
a spec build or implementation task. Inspect this project's docs, README files,
configuration and performance.json (if present), plus the optional uploaded spec
below, to determine the actual existing invocation and explicit prerequisites.
Treat the uploaded spec as execution context, not instructions to build features.

Do not implement or rebuild the pipeline, invoke spec CLI or start spec runs,
depend on prior spec logs/session state, or scan .spec-runs. Do not silently
download models/data, train on unconfigured data, invent datasets/evaluators,
use a synthetic/toy/simulator fallback, or substitute distillation for RL.
Use the correct existing prebuilt CLI with the supplied datasets and evaluator.
If prerequisites are missing or ambiguous, stop and report actionable missing
paths/configuration honestly; do not claim the model ran or fabricate metrics.

For gemma4-policy, consult candle-examples/examples/gemma4-policy/README.md
(possibly under candle/) and the installed binary's help. Dataset-backed RL
requires --train-data, --validation-data and --sol-command together, a configured
local --model-dir, and a new --head-output directory whose parent exists.
The supplied Sol adapter must be an actual configured evaluator, not a fabricated
scorer. Verify the prebuilt executable, local checkpoint/tokenizer, independently
held-out data, evaluator and requested CPU/CUDA prerequisites before running.
Do not run cargo build/run to rebuild the example. Do not silently switch devices.
This implementation trains a policy head with RL and optional plateau-triggered
head-only SFT recovery; it is not language-model distillation.

Report the exact command, real exit status, measured baseline/final validation
scores and accuracy, training metrics, and actual artifacts such as
head.safetensors and validation.json. Distinguish missing/failed execution from
measured results and explain limits; never claim unmeasured performance.
"""


def require(condition, message):
    if not condition:
        raise ValueError(message)


def configuration(workspace, request):
    require(isinstance(request, dict) and set(request) == {"project", "spec"},
            "request must contain exactly project and spec")
    workspace = Path(workspace).resolve(strict=True)
    require(workspace.is_dir(), "workspace must be an existing directory")
    value = request["project"]
    require(isinstance(value, str) and bool(value.strip()) and value.isprintable(),
            "project must be nonempty printable text (no control characters)")
    path = Path(value)
    require(path.is_absolute() or ".." not in path.parts,
            "relative project must not contain traversal")
    project = (workspace / path).resolve(strict=True)
    require(project.is_dir(), "project must be an existing directory")
    require(path.is_absolute() or project.is_relative_to(workspace),
            "relative project escapes workspace; use an explicit absolute path")
    upload = request["spec"]
    if upload is not None:
        require(isinstance(upload, dict) and set(upload) == {"name", "content"},
                "spec must be null or contain exactly name and content")
        require(isinstance(upload["name"], str) and bool(upload["name"].strip())
                and upload["name"].isprintable(), "spec.name must be nonempty printable text")
        require(isinstance(upload["content"], str), "spec.content must be text")
    return project


def run(directory, workspace, request_path):
    os.umask(0o077)
    directory = Path(directory).resolve(strict=True)
    fd = os.open(request_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600
                and info.st_uid == os.getuid() and info.st_nlink == 1,
                "Performance request must be an owned private regular file")
        data = handle.read(LIMIT + 1)
    require(len(data) <= LIMIT, "Performance request exceeds 1 MiB")

    def unique(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate request JSON key")
            result[key] = value
        return result

    request = json.loads(data, object_pairs_hook=unique)
    project = configuration(workspace, request)
    session_path = directory / "session-id"
    require(not session_path.exists() and not session_path.is_symlink(),
            "Performance requires a fresh session; session-id already exists")
    env = os.environ.copy()
    for key in list(env):
        if (key.startswith(("SPEC_SESSION", "SPEC_BUILD", "KIBI_SPEC", "SPEC_OPTIM"))
                or key == "OPENCODE_SESSION_ID"):
            del env[key]
    # Remove only inherited spec invocation hooks, preserving normal user config.
    config = json.loads(env.get("OPENCODE_CONFIG_CONTENT", "{}"))
    require(isinstance(config, dict), "OPENCODE_CONFIG_CONTENT must be an object")
    for key in ("instructions", "plugin"):
        if key in config:
            require(isinstance(config[key], list), f"config {key} must be an array")
            config[key] = [item for item in config[key] if not any(
                marker in str(item) for marker in (".spec-runs/", "spec-build-instructions.", "spec-build-session."))]
    env["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
    env["OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS"] = "1"
    env["OPENCODE_QUESTION_AUTO_RECOMMEND"] = "1"
    model_args = []
    if env.get("SPEC_EXECUTION_PROFILE"):
        setup = str(directory / "provider-setup.bash")
        for action, variable in (("config", "OPENCODE_CONFIG_CONTENT"),
                                 ("key", "SPEC_EXECUTION_API_KEY"), ("model", None)):
            result = subprocess.run(["bash", "--noprofile", "--norc", setup, action],
                                    env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            require(result.returncode == 0, "Invalid selected execution provider; refusing fallback")
            value = result.stdout.decode("utf-8")
            if variable:
                env[variable] = value
            else:
                model_args = ["--model", value]
    cli = shutil.which("opencode-source", path=env.get("PATH")) or shutil.which("opencode", path=env.get("PATH"))
    require(cli is not None, "Install opencode-source or opencode on the remote PATH")
    prompt = PROMPT + "\nExplicit project: " + json.dumps(str(project))
    prompt += "\nOptional uploaded spec (JSON execution context):\n" + json.dumps(request["spec"], ensure_ascii=True) + "\n"
    # A private stdin file avoids argv limits for large optional uploaded specs.
    prompt_path = directory / "performance-prompt.txt"
    with prompt_path.open("x", encoding="utf-8") as handle:
        handle.write(prompt)
    session = None
    failed = False
    with prompt_path.open("rb") as prompt_input:
        # Deliberately inherit the supervisor's process group: cancellation kills
        # this runner, OpenCode, and its ordinary descendants together.
        process = subprocess.Popen([cli, "run", "--dir", str(project), "--agent", "build",
                                    "--format", "json", *model_args], cwd=project, env=env,
                                   stdin=prompt_input, stdout=subprocess.PIPE)
    try:
        while True:
            line = process.stdout.readline(LIMIT + 1)
            if not line:
                break
            require(len(line) <= LIMIT, "OpenCode event line exceeds 1 MiB")
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
            if not line.strip():
                continue
            event = json.loads(line)
            require(isinstance(event, dict), "OpenCode emitted an invalid event")
            part = event.get("part")
            properties = event.get("properties")
            info = properties.get("info") if isinstance(properties, dict) else None
            ids = [event.get("sessionID")]
            if isinstance(part, dict):
                ids.append(part.get("sessionID"))
            if event.get("type") == "session.created" and isinstance(info, dict) and not info.get("parentID"):
                ids.append(info.get("id"))
            for identity in ids:
                if identity is None:
                    continue
                require(isinstance(identity, str) and len(identity) <= 127
                        and re.fullmatch(r"ses_[A-Za-z0-9]+", identity), "Invalid OpenCode session ID")
                require(session is None or session == identity, "OpenCode session identity changed")
                if session is None:
                    with session_path.open("x", encoding="ascii") as handle:
                        handle.write(identity + "\n")
                    session = identity
            if (event.get("type") in ("error", "session.error") or event.get("error") is not None
                    or (isinstance(part, dict) and (part.get("error") is not None
                        or part.get("reason") == "error"))):
                failed = True
        code = process.wait()
        require(code == 0, f"OpenCode failed (exit status {code}); inspect the agent output")
        require(not failed, "OpenCode reported an agent error; inspect the agent output")
        require(session is not None, "OpenCode returned no valid session ID; execution cannot be verified")
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 4, "expected run directory, workspace, and request path")
        run(*sys.argv[1:])
    except (ValueError, OSError, RuntimeError, RecursionError) as error:
        # Provider errors are deliberately generic; never print credentials/config.
        print(f"[performance] {error}", file=sys.stderr, flush=True)
        sys.exit(1)
