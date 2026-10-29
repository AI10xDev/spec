"""Fixed, read-only lookup of exact spec-named logs, independent of local jobs."""
import contextlib
import fcntl
import json
import os
import re
import stat
import sys
import time

MAX_OUTPUT = 262144
MAX_REPORT = 8388608
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")


class NotSpecReport(ValueError):
    pass


class AmbiguousProvenance(ValueError):
    pass


@contextlib.contextmanager
def private(parent, name, directory=False):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    if directory:
        flags |= os.O_DIRECTORY
    fd = os.open(name, flags, dir_fd=parent)
    try:
        info = os.fstat(fd)
        if (info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != (0o700 if directory else 0o600)
                or (not directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1))):
            raise ValueError("unsafe retained run storage")
        yield fd
    finally:
        os.close(fd)


def candidate(root, workspace, run_id, name, historical, full_report=False):
    with private(root, "run-" + run_id, True) as run:
        # Never substitute output.log, including when the selected log disappears.
        with private(run, name + ".out") as log:
            workspace = os.path.normpath(workspace)
            expected = [os.fsencode(workspace), b"build", os.fsencode(name),
                        os.fsencode(os.path.join(workspace, ".spec-runs", "run-" + run_id, name + ".out")), b""]
            try:
                with private(run, "provenance") as provenance:
                    fields = os.read(provenance, 16385).split(b"\0")
                    if (os.fstat(provenance).st_size > 16384 or len(fields) != 5
                            or fields[1] not in (b"build", b"continue", b"repository-save", b"optimize")
                            or fields[0] != expected[0] or fields[2:] != expected[2:]):
                        raise ValueError("retained log lacks matching name/run-kind provenance")
                    if fields[1] == b"optimize":
                        raise NotSpecReport("optimizer output is not an ordinary spec report")
            except FileNotFoundError:
                if name == "optimization":
                    # Shipped initial builds have concrete invocation evidence.
                    # A session ID alone cannot distinguish old continuations.
                    try:
                        with private(run, "invocation") as invocation:
                            if (os.fstat(invocation).st_size > 16384
                                    or os.read(invocation, 16385) != b"\0".join(expected)):
                                raise ValueError("retained log lacks matching initial-build invocation")
                    except FileNotFoundError:
                        raise AmbiguousProvenance(
                            "Retained run " + run_id + " has ambiguous legacy provenance for optimization. "
                            "Choose a report with verified name/run-kind provenance or a legacy initial-build invocation; "
                            "inspect the original retained log manually. A session ID is not sufficient proof.") from None
            try:
                with private(run, "status") as status:
                    code = os.read(status, 5)
                    if not re.fullmatch(rb"(0|[1-9][0-9]{0,2})\n?", code):
                        raise ValueError("invalid retained run status")
                    code = int(code)
                    if code > 255:
                        raise ValueError("invalid retained run status")
                    status = {0: "completed", 124: "timed out", 130: "cancelled"}.get(
                        code, "failed (exit status: %d)" % code)
            except FileNotFoundError:
                with private(run, "lease") as lease:
                    status = "unknown (remote status unavailable)"
                    try:
                        fcntl.flock(lease, fcntl.LOCK_SH | fcntl.LOCK_NB)
                        fcntl.flock(lease, fcntl.LOCK_UN)
                    except BlockingIOError:
                        status = "running"
            # A terminal status is published after the final log writes. Sample
            # size afterwards so a finishing run cannot lose its final bytes.
            info = os.fstat(log)
            if info.st_size > MAX_REPORT and not full_report:
                raise ValueError("retained log exceeds size limit")
            if not historical:
                return {"id": run_id, "modified": info.st_mtime_ns // 1000000000}
            limit = MAX_REPORT if full_report else MAX_OUTPUT
            count = min(info.st_size, limit)
            output = os.pread(log, count, 0 if full_report else info.st_size - count)
            if len(output) != count:
                raise ValueError("retained log changed during read")
            after = os.fstat(log)
            changed = full_report and (info.st_size != after.st_size
                                       or info.st_mtime_ns != after.st_mtime_ns)
            lossy = False
            try:
                text = output.decode("utf-8")
            except UnicodeDecodeError:
                text = output.decode("utf-8", "replace")
                lossy = full_report
            # The supervisor may already have discarded bytes at exactly MAX_REPORT.
            truncated = info.st_size >= limit if full_report else info.st_size > limit
            return {"id": run_id, "name": name, "output": text,
                    "status": status, "truncated": truncated or changed or lossy,
                    "recoverable": False, "continuable": False}


def main():
    workspace, name, run_id = sys.argv[1:4]
    mode = sys.argv[4] if len(sys.argv) == 5 else "tail"
    if len(sys.argv) not in (4, 5) or mode not in ("tail", "full"):
        raise ValueError("invalid retained read mode")
    full_report = mode == "full"
    if (not name or name.startswith(".") or name.strip() != name
            or len(name.encode("utf-8")) > 180
            or any(c in "/\\:" or ord(c) < 32 or 127 <= ord(c) <= 159 for c in name)
            or (run_id and not UUID.fullmatch(run_id))):
        raise ValueError("invalid retained run request")
    # The operator's workspace may be a symlink, as with the build/recovery cd.
    # All storage below this opened workspace still requires O_NOFOLLOW.
    workspace_fd = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY)
    try:
        with contextlib.ExitStack() as stack:
            try:
                root = stack.enter_context(private(workspace_fd, ".spec-runs", True))
            except FileNotFoundError:
                if full_report and not run_id:
                    return {"runs": [], "truncated": False}
                raise
            if run_id:
                return candidate(root, workspace, run_id, name, True, full_report)
            runs = []
            warnings = []
            truncated = False
            deadline = time.monotonic() + 5
            # scandir is lazy: neither directory size nor invalid entries can cause
            # unbounded allocation/work. Sort only the bounded set actually inspected.
            with os.scandir(root) as entries:
                for index, entry in enumerate(entries):
                    if index >= 4096 or len(runs) >= 128 or time.monotonic() >= deadline:
                        truncated = True
                        break
                    if not entry.name.startswith("run-") or not UUID.fullmatch(entry.name[4:]):
                        continue
                    try:
                        runs.append(candidate(root, workspace, entry.name[4:], name, False, full_report))
                    except NotSpecReport:
                        continue
                    except AmbiguousProvenance as error:
                        if full_report and not warnings:
                            warnings.append("Some retained reports were omitted: " + str(error))
                        continue
                    except (OSError, ValueError) as error:
                        # Analytics must not misrepresent unreadable storage as no history.
                        if full_report and not (isinstance(error, FileNotFoundError)
                                                and error.filename in (entry.name, name + ".out")):
                            raise
                        continue
            runs.sort(key=lambda run: (-run["modified"], run["id"]))
            return {"runs": runs, "truncated": truncated, **({"warnings": warnings} if warnings else {})}
    finally:
        os.close(workspace_fd)


try:
    print(json.dumps(main(), ensure_ascii=True, separators=(",", ":")))
except (OSError, ValueError) as error:
    print("retained run lookup failed: " + str(error), file=sys.stderr)
    sys.exit(125)
