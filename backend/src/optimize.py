#!/usr/bin/env python3
"""Stdlib optimizer; also runnable unchanged when saved as snapshot.md."""

from contextlib import contextmanager
import ctypes
import fcntl
import json
import math
import os
from pathlib import Path
import re
import selectors
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass


CONFIG_LIMIT = 1024 * 1024
METRIC_LIMIT = 4096
COMMAND_LOG_LIMIT = 8 * 1024 * 1024
TOOL_OUTPUT_LIMIT = 64 * 1024
MODEL = "gpt-6-sol"
SYSTEM_PROMPT = "Optimize above till asymptotics"
COMPLETION_CONVENTION = (
    "Outside fenced and indented code blocks, a leading single '# ' after optional indentation marks only "
    "that line completed. Preserve it as context, do not implement it again. A line containing only '#' "
    "is a completed blank line. '##' and deeper headings, '#tag', inline hashes, and hashes inside code "
    "are not completion markers. Subsequent unmarked lines remain pending."
)
NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")


class OptimizeError(Exception):
    pass


@dataclass(frozen=True)
class Invocation:
    project: Path
    filename: str
    output: Path
    source: str
    timestamp: int | None = None

    def identity(self):
        return self.project, self.filename, self.output


def read_limited(path, limit):
    if not stat.S_ISREG(path.stat().st_mode):
        raise OptimizeError(f"{path}: expected a regular file")
    with path.open("rb") as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise OptimizeError(f"{path}: exceeds {limit} bytes")
    return data


def validate_invocation(invocation):
    if not invocation.project.is_absolute() or not invocation.project.is_dir():
        raise OptimizeError("invocation project must be an existing absolute directory")
    if not invocation.filename or "\0" in invocation.filename:
        raise OptimizeError("invocation filename must be nonempty")
    if (not invocation.output.is_absolute() or invocation.output.suffix != ".out"
            or not invocation.output.is_file()):
        raise OptimizeError(f"invocation output must be an existing regular .out file: {invocation.output}")
    return invocation


def latest(candidates):
    timestamp = max(item.timestamp for item in candidates)
    newest = [item for item in candidates if item.timestamp == timestamp]
    if len({item.identity() for item in newest}) != 1:
        raise OptimizeError("ambiguous latest build: equal timestamps")
    return sorted(newest, key=lambda item: item.source)[0]


def history_invocation(history, workspace, recorded_time=None):
    """Parse a narrow grammar, never execute or expand shell/history text."""
    if not history.exists():
        return None
    # Only the last relevant entry may be used, even if it is unsupported.
    candidate = None
    timestamp = None
    for line in read_limited(history, 16 * CONFIG_LIMIT).decode("utf-8", "strict").splitlines():
        if re.fullmatch(r"#[0-9]{1,12}", line):
            timestamp = int(line[1:]) * 1_000_000_000
            continue
        if re.search(r"\bnohup\b", line):
            candidate = line, timestamp
        timestamp = None
    if candidate is None:
        return None
    line, timestamp = candidate
    if recorded_time is not None and timestamp is not None and timestamp < recorded_time:
        return None
    try:
        # Reject expansion even inside quotes: history is only an identity hint.
        if any(char in line for char in "$`\\\0{}!#"):
            raise ValueError("shell expansion or escapes")
        for quoted in re.findall(r"'[^']*'|\"[^\"]*\"", line):
            if any(char in quoted for char in ";&|<>()"):
                raise ValueError("quoted shell operator")
        lexer = shlex.shlex(line, posix=True, punctuation_chars=";&|<>()")
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
        if tokens[-4:] == ["2", ">&", "1", "&"]:
            tokens = tokens[:-4] + ["&"]
        project = workspace
        has_cd = tokens[:1] == ["cd"]
        if has_cd:
            if len(tokens) < 4 or tokens[2] != "&&" or not Path(tokens[1]).is_absolute():
                raise ValueError("expected cd /absolute/project &&")
            project = Path(tokens[1])
            tokens = tokens[3:]
        shell_directory = project
        if (len(tokens) < 6 or tokens[0] != "nohup" or tokens[-1] != "&"
                or tokens[-3] != ">"):
            raise ValueError("expected nohup COMMAND > OUTPUT &")
        output = tokens[-2]
        command = tokens[1:-3]
        if len(command) == 3 and Path(command[0]).name == "spec" and command[1] == "build":
            filename = command[2]
        elif len(command) == 2 and Path(command[0]).name in ("run_goal", "run-spec.sh"):
            filename = command[1]
        elif len(command) >= 7 and command[1] == "run":
            options = command[2:-1]
            flags = {}
            while options:
                flag = options.pop(0)
                if flag in flags or flag not in ("--dir", "--agent", "--thinking"):
                    raise ValueError("unsupported or duplicate runner flag")
                if flag == "--thinking":
                    flags[flag] = True
                elif options:
                    flags[flag] = options.pop(0)
                else:
                    raise ValueError("missing runner flag value")
            if flags.get("--agent") != "build" or not Path(flags.get("--dir", "")).is_absolute():
                raise ValueError("expected --dir /absolute/project and --agent build")
            explicit = Path(flags["--dir"])
            if has_cd and project != explicit:
                raise ValueError("conflicting project directories")
            project = explicit
            filename = command[-1]
        else:
            raise ValueError("unsupported build command")
        # Operator-like or option-like identities cannot silently become paths.
        for value in (str(project), filename, output, command[0]):
            if not value or value.startswith("-") or any(c in value for c in ";&|<>()*?[]~"):
                raise ValueError("unsafe or ambiguous path")
        return Invocation(project, filename, shell_directory / output, str(history), timestamp)
    except ValueError as error:
        raise OptimizeError(f"latest nohup history entry is unsupported or ambiguous: {error}") from error


def discover(workspace, history=None):
    workspace = Path(workspace).resolve(strict=True)
    if not workspace.is_dir():
        raise OptimizeError("WORKSPACE must be a directory")
    runs = sorted((workspace / ".spec-runs").glob("run-*"))
    records = [run / "invocation" for run in runs if (run / "invocation").exists()]
    recorded = None
    if records:
        # Select by metadata mtime, not an output that may still be growing.
        newest_time = max(path.stat().st_mtime_ns for path in records)
        candidates = []
        for path in records:
            if path.stat().st_mtime_ns != newest_time:
                continue
            fields = read_limited(path, CONFIG_LIMIT).split(b"\0")
            if len(fields) != 5 or fields[1] != b"build" or fields[-1] != b"":
                raise OptimizeError(f"malformed initial-build invocation: {path}")
            project, _, filename, output, _ = map(os.fsdecode, fields)
            candidates.append(Invocation(Path(project), filename, Path(output), str(path), newest_time))
        recorded = latest(candidates)

    legacy = []
    for run in ([] if recorded else runs):
        outputs = sorted(path for path in run.glob("*.out") if path.name != "optimization.out")
        if len(outputs) > 1:
            raise OptimizeError(f"ambiguous legacy run (multiple .out files): {run}")
        if outputs:
            path = outputs[0]
            legacy.append(Invocation(workspace, path.name[:-4], path, str(path), path.stat().st_mtime_ns))
    old = recorded or (latest(legacy) if legacy else None)
    historical = history_invocation(Path.home() / ".bash_history" if history is None else Path(history),
                                    workspace, recorded.timestamp if recorded else None)
    if historical and old:
        if historical.timestamp is None:
            if historical.identity() != old.identity():
                raise OptimizeError("cannot order untimestamped history against recorded build")
            selected = old
        else:
            selected = latest([old, historical])
    else:
        selected = historical or old
    if selected is None:
        raise OptimizeError("no initial build invocation found")
    return validate_invocation(selected)


def config_path(invocation):
    name = Path(invocation.filename).name
    for candidate in (invocation.project / (name + ".optim"),
                      invocation.project / (Path(name).stem + ".optim")):
        if candidate.exists():
            if not candidate.is_file():
                raise OptimizeError(f"config is not a regular file: {candidate}")
            return candidate
    candidates = sorted(invocation.project.glob("*.optim"))
    if len(candidates) != 1 or not candidates[0].is_file():
        raise OptimizeError("expected a filename-matched .optim or exactly one project-root *.optim")
    return candidates[0]


@contextmanager
def project_lock(project):
    # Match remote-build.bash: Git subdirectories share a worktree registry;
    # linked worktrees and non-Git projects have separate lock scopes.
    env = os.environ.copy()
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
        env.pop(key, None)
    directory = project / ".spec-runs"
    try:
        probe = subprocess.run(["git", "rev-parse", "--is-inside-work-tree", "--absolute-git-dir"],
                               cwd=project, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, timeout=10)
    except FileNotFoundError:
        pass
    else:
        if probe.returncode == 0 and probe.stdout.startswith(b"true\n"):
            directory = Path(os.fsdecode(probe.stdout[5:].rstrip(b"\n"))).resolve(strict=True) / "spec-harness"
    directory.mkdir(mode=0o700, exist_ok=True)
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise OptimizeError(f"unsafe target lock directory: {directory}")
        # The supervisor retains this lock, but deliberately closes its descriptor
        # in children. Reopening and locking the same inode would conflict with it.
        if os.environ.get("SPEC_OPTIM_WORKSPACE_LOCK") != f"{info.st_dev}:{info.st_ino}":
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise OptimizeError(f"another harness is active for target project: {project}") from error
        yield
    finally:
        os.close(fd)


def load_config(path, text=None):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise OptimizeError(f"duplicate config key: {key}")
            result[key] = value
        return result

    def invalid_constant(value):
        raise OptimizeError(f"nonfinite JSON constant: {value}")

    config = json.loads(read_limited(path, CONFIG_LIMIT) if text is None else text, object_pairs_hook=unique,
                        parse_constant=invalid_constant)
    if (not isinstance(config, dict) or set(config) != {"version", "objectives"}
            or type(config["version"]) is not int or config["version"] != 1):
        raise OptimizeError("config requires version 1 and objectives, with no unknown keys")
    objectives = config["objectives"]
    if not isinstance(objectives, list) or not 1 <= len(objectives) <= 128:
        raise OptimizeError("objectives must contain 1..128 entries")
    names = set()
    required = {"name", "command", "measure", "direction"}
    optional = {"absolute_tolerance", "relative_tolerance", "patience", "timeout_seconds"}
    for objective in objectives:
        if (not isinstance(objective, dict) or not required <= objective.keys()
                or objective.keys() - required - optional):
            raise OptimizeError("objective has missing or unknown keys")
        name = objective["name"]
        if (not isinstance(name, str) or not name.strip() or len(name) > 200
                or not name.isprintable() or name in names):
            raise OptimizeError("objective names must be unique, printable, nonempty, at most 200 characters")
        names.add(name)
        for key in ("command", "measure"):
            argv = objective[key]
            if (not isinstance(argv, list) or not 1 <= len(argv) <= 256
                    or any(not isinstance(arg, str) or "\0" in arg for arg in argv)
                    or not argv[0] or sum(len(arg) for arg in argv) > 65536):
                raise OptimizeError(f"{name}: {key} must be a bounded nonempty argv array")
        if objective["direction"] not in ("maximize", "minimize"):
            raise OptimizeError(f"{name}: direction must be maximize or minimize")
        for key, default, bound in (("absolute_tolerance", 1e-6, 1e100),
                                    ("relative_tolerance", 1e-4, 1.0),
                                    ("timeout_seconds", None, 86400)):
            value = objective.setdefault(key, default)
            if value is None and key == "timeout_seconds":
                continue
            if (type(value) not in (int, float) or not 0 <= value <= bound
                    or not math.isfinite(value) or (key == "timeout_seconds" and value == 0)):
                raise OptimizeError(f"{name}: invalid {key} (maximum {bound})")
        patience = objective.setdefault("patience", 3)
        if type(patience) is not int or not 2 <= patience <= 10000:
            raise OptimizeError(f"{name}: patience must be an integer in 2..10000")
    return objectives


class ResponsesOptimizer:
    """Model-guided steps; only independently measured scores determine stopping."""

    def __init__(self, spec, invocation, reporter):
        endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT", "https://api.openai.com/v1")
        azure = "AZURE_OPENAI_ENDPOINT" in os.environ
        key = os.environ.get("AZURE_OPENAI_API_KEY" if azure else "OPENAI_API_KEY", "")
        url = urllib.parse.urlsplit(endpoint)
        if (url.scheme != "https" or not url.hostname or url.username or url.password
                or url.query or url.fragment or any(c.isspace() for c in endpoint)):
            raise OptimizeError("Responses endpoint must be HTTPS without credentials, query, or fragment")
        path = url.path.rstrip("/")
        allowed = ("", "/openai/v1", "/openai/v1/responses") if azure else ("/v1", "/v1/responses")
        if path not in allowed:
            raise OptimizeError("Responses endpoint must end in /openai/v1[/responses] for Azure")
        if not key or not key.isascii() or any(c.isspace() for c in key):
            raise OptimizeError("Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY, or OPENAI_API_KEY on the execution host")
        self.url = urllib.parse.urlunsplit(url._replace(path="/openai/v1/responses" if azure else "/v1/responses"))
        self.headers = {"Content-Type": "application/json",
                        "api-key" if azure else "Authorization": key if azure else "Bearer " + key}
        self.invocation = invocation
        self.reporter = reporter
        # Bound build logs independently of how long the original build ran.
        with invocation.output.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - TOOL_OUTPUT_LIMIT))
            output = handle.read(TOOL_OUTPUT_LIMIT).decode("utf-8", "replace")
        source = invocation.project / invocation.filename
        objective_text = read_limited(source, CONFIG_LIMIT).decode("utf-8") if source.is_file() else "(original objective file unavailable)"
        self.context = json.dumps({"project": str(invocation.project), "filename": invocation.filename,
                                   "objectives": objective_text, "build_output_tail": output,
                                   "build_output_truncated": size > TOOL_OUTPUT_LIMIT, "optim_spec": spec})

    def request(self, messages):
        tool = {"type": "function", "name": "run_command",
                "description": "Execute a trusted project command in the project directory. Do not daemonize. Output is bounded.",
                "parameters": {"type": "object", "properties": {
                    "argv": {"type": "array", "items": {"type": "string"}, "minItems": 1}},
                    "required": ["argv"], "additionalProperties": False}, "strict": True}
        payload = {"model": MODEL, "instructions": SYSTEM_PROMPT, "input": messages,
                   "tools": [tool], "parallel_tool_calls": False, "store": False,
                   "include": ["reasoning.encrypted_content"]}
        request = urllib.request.Request(self.url, data=json.dumps(payload).encode(), headers=self.headers)

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None

        try:
            with urllib.request.build_opener(NoRedirect).open(request, timeout=300) as response:
                raw = response.read(4 * CONFIG_LIMIT + 1)
            if len(raw) > 4 * CONFIG_LIMIT:
                raise OptimizeError("Responses payload exceeds 4 MiB")
            body = json.loads(raw)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            # Provider bodies and URLs may include sensitive details.
            raise OptimizeError("Responses request failed; check execution-host credentials and provider availability") from None
        if not isinstance(body, dict) or body.get("status") != "completed" or not isinstance(body.get("output"), list):
            raise OptimizeError("Responses request did not complete successfully")
        return body["output"]

    def agent(self, prompt, objective, iteration):
        messages = [{"role": "user", "content": self.context + "\n\n" + COMPLETION_CONVENTION + "\n\n" + prompt}]
        ran_process = False
        while True:
            self.reporter.emit("model_request", model=MODEL, objective=objective["name"], iteration=iteration)
            output = self.request(messages)
            messages.extend(output)
            calls = [item for item in output if item.get("type") == "function_call"]
            if not calls:
                text = []
                for item in output:
                    if item.get("type") == "reasoning":
                        continue
                    if item.get("type") != "message" or item.get("role") != "assistant":
                        raise OptimizeError("Unexpected Responses output")
                    for part in item.get("content", []):
                        if part.get("type") != "output_text":
                            raise OptimizeError("Responses refused or returned unsupported content")
                        text.append(part["text"])
                if not text or not "".join(text).strip():
                    raise OptimizeError("Responses returned no result")
                if iteration > 0 and not ran_process:
                    self.reporter.emit("process", objective=objective["name"], iteration=iteration,
                                       argv=objective["command"])
                    execute(objective["command"], self.invocation, objective, iteration, "command", self.reporter)
                return "".join(text)
            for call in calls:
                if call.get("name") != "run_command" or not call.get("call_id"):
                    raise OptimizeError("Responses requested an unsupported tool")
                arguments = json.loads(call["arguments"])
                argv = arguments.get("argv") if isinstance(arguments, dict) else None
                if (not isinstance(argv, list) or not 1 <= len(argv) <= 256
                        or any(not isinstance(arg, str) or "\0" in arg for arg in argv)
                        or not argv[0] or sum(map(len, argv)) > 65536
                        or set(arguments) != {"argv"}):
                    raise OptimizeError("Responses tool requires a bounded argv array")
                self.reporter.emit("model_tool", objective=objective["name"], iteration=iteration, argv=argv)
                result = execute(argv, self.invocation, objective, iteration, "tool", self.reporter)
                # Any subsequent tool may mutate the validated state, even an inspection.
                ran_process = argv == objective.get("command") and json.loads(result)["exit_code"] == 0
                messages.append({"type": "function_call_output", "call_id": call["call_id"], "output": result})

    def plan(self, path):
        prompt = (
            "Read the original objectives and free-form .optim process above. Inspect the project using run_command as needed. "
            "Do not optimize yet. Preserve existing user changes and never read credentials. "
            "Return ONLY a JSON object with version: 1 and objectives: an array. Each objective must have name, "
            "command (argv for one repeatable optimization attempt including correctness validation), "
            "measure (argv printing one finite numeric scalar), "
            "direction (maximize or minimize). Optional absolute_tolerance, relative_tolerance, patience (at least 2), "
            "timeout_seconds. Default tolerances are 1e-6 absolute and 1e-4 relative, patience 3. "
            "The OpenCode build agent performs a focused refactor before the command each iteration; "
            "use a project command for validation/process work, not a nested spec build/Optimize harness "
            "that would contend for the scheduler's project lock. "
            "Use meaningful, repeatable, read-only measurements and the stopping thresholds specified by .optim, "
            "not invented scores or tolerances chosen to force convergence. Measurement definitions must remain fixed "
            "throughout the run. If no real measurement can be established, explain why instead of inventing one. "
            "Include every pending objective and its corresponding optimization process; respect completed spec lines."
        )
        text = self.agent(prompt, {"name": "planning", "timeout_seconds": 300}, 0)
        objectives = load_config(path, text)
        self.reporter.emit("plan", model=MODEL, objectives=objectives)
        return objectives

    def step(self, objective, iteration, states):
        builder = self.build(objective, iteration, states)
        prompt = (
            "Perform one optimization iteration for the current objective using its corresponding .optim process. "
            "The OpenCode build agent has already attempted this iteration; review its result below, "
            "validate the changes, and repair failed validation rather than repeating its refactor. "
            "Use run_command to inspect and actually apply improvements, including running the planned command when appropriate. "
            "The planned command must succeed each iteration: the scheduler runs it after your summary unless you already "
            "ran that exact argv successfully as your last tool. Every subsequent tool invalidates that success. "
            "Tool outputs include exit_code; diagnose and repair failed attempts. "
            "Preserve unrelated user changes. Do not change measurement definitions, fabricate scores, read credentials, "
            "or declare convergence; the scheduler measures all objectives after the round. "
            "Finish with a brief factual summary of actions and evidence. Previous measured state and summaries follow:\n"
            + json.dumps({"objective": objective, "iteration": iteration, "states": states,
                          "builder_result": builder})
        )
        summary = self.agent(prompt, objective, iteration)
        self.reporter.emit("model_step", objective=objective["name"], iteration=iteration, summary=summary)
        return summary

    def build(self, objective, iteration, states):
        executable = os.environ.get("SPEC_OPTIM_OPENCODE", "opencode")
        if not executable or "\0" in executable:
            raise OptimizeError("SPEC_OPTIM_OPENCODE must name an OpenCode executable, not shell syntax")
        prompt = (
            "Perform exactly one optimization attempt for the current objective using its corresponding "
            "free-form .optim process. Use the explore subagent to inspect relevant code when useful, "
            "then apply a focused refactor as the build agent and validate correctness. "
            "Preserve unrelated edits and completed requirements. Do not commit, read credentials, "
            "modify measurement definitions, invent scores, or decide convergence. Do not launch a "
            "nested spec build/Optimize harness: the scheduler already holds the project lock. "
            "Return a factual summary of changes, validation, and any blockers. "
            "The scheduler will independently measure every objective after this round.\n\n"
            + COMPLETION_CONVENTION + "\n\n" + self.context + "\n\n"
            + json.dumps({"objective": objective, "iteration": iteration, "states": states})
        )
        # Stdin avoids argv limits and OpenCode's truncating file-attachment reader.
        with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as source:
            source.write(prompt)
            source.seek(0)
            argv = [executable, "run", "--dir", str(self.invocation.project), "--agent", "build",
                    "--auto", "--format", "json", "--",
                    "Follow the optimization iteration instructions supplied on stdin."]
            self.reporter.emit("builder_start", objective=objective["name"], iteration=iteration, argv=argv)
            result = json.loads(execute(argv, self.invocation, objective, iteration, "builder", self.reporter,
                                        input_file=source))
        self.reporter.emit("builder_result", objective=objective["name"], iteration=iteration, **result)
        if result["exit_code"] != 0:
            raise OptimizeError(f"{objective['name']}: OpenCode builder exited {result['exit_code']}")
        return result


class Reporter:
    def __init__(self, directory):
        directory.mkdir(parents=True, exist_ok=True)
        self.progress = (directory / "progress.log").open("a", encoding="utf-8")
        self.report = (directory / "report.jsonl").open("a", encoding="utf-8")
        self.commands = (directory / "commands.log").open("ab")

    def emit(self, event, **fields):
        record = json.dumps({"event": event, "timestamp": time.time(), **fields}, allow_nan=False, ensure_ascii=True, sort_keys=True)
        for handle in (self.progress, self.report):
            handle.write(record + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        self.commands.flush()
        os.fsync(self.commands.fileno())
        print(record, flush=True)

    def command_output(self, data):
        remaining = max(0, COMMAND_LOG_LIMIT - self.commands.tell())
        self.commands.write(data[:remaining])
        self.commands.flush()

    def close(self):
        for handle in (self.progress, self.report, self.commands):
            handle.close()


def supervise_command(argv):
    """Own only this command's descendants, including detached/double-forked tools."""
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "cannot enable command subreaper")
    children = Path(f"/proc/self/task/{os.getpid()}/children")
    children.read_text()  # Fail before spawning if procfs cannot enumerate our children.

    def interrupted(signum, frame):
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    status = 1
    leftover = False
    try:
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGINT, signal.SIGTERM})
        status = subprocess.Popen(argv).wait()
    except KeyboardInterrupt:
        status = 130
    except OSError as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr, flush=True)
        status = 127
    finally:
        # Repeated cancellation must not interrupt cleanup and release the project lock.
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
        while True:
            try:
                pids = [int(pid) for pid in children.read_text().split()]
                if not pids:
                    break
                pids = [pid for pid in pids if os.waitpid(pid, os.WNOHANG)[0] == 0]
                leftover = leftover or bool(pids)
                # Unreaped direct children cannot have their PIDs reused. Killing and
                # reaping parents adopts their descendants; repeat until none remain.
                for pid in pids:
                    os.kill(pid, signal.SIGKILL)
                for pid in pids:
                    os.waitpid(pid, 0)
            except OSError as error:
                print(f"Descendant cleanup incomplete; retaining supervisor: {error}",
                      file=sys.stderr, flush=True)
                time.sleep(1)
    if status == 0 and leftover:
        print("Command left descendants running; terminated them and refusing success", file=sys.stderr, flush=True)
        return 1
    return status if status >= 0 else 128 - status


def execute(argv, invocation, objective, iteration, phase, reporter, input_file=None):
    env = os.environ.copy()
    # A nested invocation must acquire its own lock, not reuse our supervisor's.
    env.pop("SPEC_OPTIM_WORKSPACE_LOCK", None)
    env.update(SPEC_OPTIM_PROJECT=str(invocation.project), SPEC_OPTIM_FILENAME=invocation.filename,
               SPEC_OPTIM_OUTPUT=str(invocation.output), SPEC_OPTIM_OBJECTIVE=objective["name"],
               SPEC_OPTIM_ITERATION=str(iteration))
    label = f"{objective['name']} iteration={iteration} {phase}"
    reporter.command_output(("\n=== " + label + " ===\n").encode("utf-8"))
    timeout = objective["timeout_seconds"]
    deadline = time.monotonic() + timeout if timeout is not None else None
    metric = bytearray()
    builder_stderr = bytearray()
    output_size = 0
    child = None
    try:
        # A private subreaper avoids claiming unrelated children of an embedding caller.
        # Block cancellation across Popen so cleanup always has the supervisor handle.
        mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
        try:
            child = subprocess.Popen([sys.executable, "-B", os.path.abspath(__file__), "--supervise", *argv],
                                     cwd=invocation.project, env=env,
                                     stdin=input_file if input_file is not None else subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, mask)
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, "stdout")
            selector.register(child.stderr, selectors.EVENT_READ, "stderr")
            while selector.get_map() or child.poll() is None:
                if deadline is not None and time.monotonic() >= deadline:
                    raise OptimizeError(f"{label}: timeout after {timeout}s")
                for key, _ in selector.select(0.05):
                    data = os.read(key.fd, 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    reporter.command_output(("[" + key.data + "] ").encode() + data)
                    if phase == "measure" and key.data == "stdout":
                        if len(metric) + len(data) > METRIC_LIMIT:
                            raise OptimizeError(f"{label}: metric stdout exceeds {METRIC_LIMIT} bytes")
                        metric.extend(data)
                    elif phase == "tool":
                        remaining = TOOL_OUTPUT_LIMIT - len(metric)
                        metric.extend(data[:remaining])
                    elif phase == "builder":
                        output_size += len(data)
                        metric.extend(data)
                        # JSON tool/model events use stdout; agent-selection warnings use stderr.
                        if key.data == "stderr":
                            builder_stderr.extend(data)
                            if b"Falling back to default agent" in builder_stderr:
                                raise OptimizeError(f"{label}: OpenCode build agent unavailable; refusing fallback")
                            del builder_stderr[:-TOOL_OUTPUT_LIMIT]
                        # Preserve the final summary after potentially verbose tool output.
                        del metric[:-TOOL_OUTPUT_LIMIT]
        if child.returncode != 0 and phase not in ("tool", "builder"):
            raise OptimizeError(f"{label}: command exited {child.returncode}")
    finally:
        mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
        try:
            if child is not None:
                if child.poll() is None:
                    child.terminate()
                child.wait()  # The subreaper finishes descendant cleanup before exiting.
                child.stdout.close()
                child.stderr.close()
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, mask)
    if phase == "measure":
        text = metric.decode("ascii", "strict").strip()
        if not NUMBER.fullmatch(text):
            raise OptimizeError(f"{label}: expected one finite numeric scalar")
        score = float(text)
        if not math.isfinite(score):
            raise OptimizeError(f"{label}: metric must be finite")
        return score
    if phase in ("tool", "builder"):
        return json.dumps({"exit_code": child.returncode, "output": metric.decode("utf-8", "replace"),
                           "truncated": output_size > TOOL_OUTPUT_LIMIT if phase == "builder"
                           else len(metric) == TOOL_OUTPUT_LIMIT})
    return None


def optimize(invocation, objectives, reporter, agent=None):
    states = []
    for objective in objectives:
        baseline = execute(objective["measure"], invocation, objective, 0, "measure", reporter)
        states.append({"name": objective["name"], "baseline": baseline, "score": baseline, "gain": None, "stable": 0})
        reporter.emit("baseline", objective=objective["name"], iteration=0, score=baseline)
    iteration = 0
    while True:
        iteration += 1
        active = [state["stable"] < objective["patience"] for objective, state in zip(objectives, states)]
        for objective, state, stepped in zip(objectives, states, active):
            if stepped:
                reporter.emit("step", objective=objective["name"], iteration=iteration)
                if agent is None:
                    execute(objective["command"], invocation, objective, iteration, "command", reporter)
                else:
                    state["summary"] = agent.step(objective, iteration, states)
        # Measure the entire shared project after the round, including plateaued objectives.
        for objective, state, stepped in zip(objectives, states, active):
            score = execute(objective["measure"], invocation, objective, iteration, "measure", reporter)
            sign = 1 if objective["direction"] == "maximize" else -1
            gain = sign * (score - state["score"])
            cumulative = sign * (score - state["baseline"])
            marginal = gain - state["gain"] if state["gain"] is not None else None
            tolerance = objective["absolute_tolerance"] + objective["relative_tolerance"] * abs(state["score"])
            if not all(math.isfinite(value) for value in (gain, cumulative, tolerance)
                       + (() if marginal is None else (marginal,))):
                raise OptimizeError(f"{objective['name']}: gain arithmetic overflow")
            stable = min(state["stable"] + 1, objective["patience"]) if abs(gain) <= tolerance else 0
            reporter.emit("iteration", objective=objective["name"], iteration=iteration,
                          stepped=stepped, previous_score=state["score"], score=score, gain=gain,
                          cumulative_gain=cumulative, marginal_difference=marginal,
                          tolerance=tolerance, stable_iterations=stable, patience=objective["patience"])
            state.update(score=score, gain=gain, stable=stable)
        if all(state["stable"] >= objective["patience"] for objective, state in zip(objectives, states)):
            reporter.emit("final", outcome="converged", iterations=iteration,
                          objectives=[{"name": objective["name"], "baseline": state["baseline"],
                                       "score": state["score"], "cumulative_gain":
                                       (1 if objective["direction"] == "maximize" else -1)
                                       * (state["score"] - state["baseline"])}
                                      for objective, state in zip(objectives, states)])
            return


def run(run_directory, workspace, history=None):
    reporter = Reporter(Path(run_directory))
    try:
        invocation = discover(workspace, history)
        with project_lock(invocation.project):
            path = config_path(invocation)
            reporter.emit("start", project=str(invocation.project), filename=invocation.filename,
                          output=str(invocation.output), source=invocation.source, config=str(path))
            text = read_limited(path, CONFIG_LIMIT).decode("utf-8-sig")
            if not text.strip():
                raise OptimizeError(".optim spec must not be empty")
            # Preserve the shipped explicit-command format; prose uses the model.
            agent = None if text.lstrip().startswith("{") else ResponsesOptimizer(text, invocation, reporter)
            objectives = load_config(path) if agent is None else agent.plan(path)
            optimize(invocation, objectives, reporter, agent)
        return 0
    except KeyboardInterrupt:
        reporter.emit("final", outcome="interrupted")
        return 130
    except Exception as error:
        reporter.emit("final", outcome="failed", error=f"{type(error).__name__}: {error}")
        return 1
    finally:
        reporter.close()


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--supervise":
        return supervise_command(sys.argv[2:])
    if len(sys.argv) != 3:
        print("usage: python3 -u snapshot.md RUN_DIRECTORY WORKSPACE", file=sys.stderr)
        return 2

    def interrupted(signum, frame):
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        return run(sys.argv[1], sys.argv[2])
    except (OSError, KeyboardInterrupt) as error:
        print(f"optimizer could not write reports: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
