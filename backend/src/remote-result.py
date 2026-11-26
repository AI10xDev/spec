"""Read a successful staged result, never an agent log or a legacy fallback."""
import contextlib
import json
import os
import re
import stat
import sys

LIMIT = 120 * 1024


@contextlib.contextmanager
def private(parent, name, directory=False):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                 | (os.O_DIRECTORY if directory else 0), dir_fd=parent)
    try:
        info = os.fstat(fd)
        if (info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != (0o700 if directory else 0o600)
                or (not directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1))):
            raise ValueError("unsafe build result storage")
        yield fd
    finally:
        os.close(fd)


def read(parent, name, limit):
    with private(parent, name) as fd:
        before = os.fstat(fd)
        if before.st_size > limit:
            raise ValueError("build result metadata exceeds limit")
        data = os.read(fd, limit + 1)
        after = os.fstat(fd)
        if (len(data) != before.st_size or before.st_size != after.st_size
                or before.st_mtime_ns != after.st_mtime_ns):
            raise ValueError("build result changed during read")
        return data


def unique(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate build result key")
        result[key] = value
    return result


def main():
    workspace, run_id, name = sys.argv[1:]
    if (not os.path.isabs(workspace)
            or not re.fullmatch(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}", run_id)
            or not name or name.startswith(".") or len(name) > 180
            or any(c in name for c in "/\\:") or any(ord(c) < 32 or ord(c) == 127 for c in name)):
        raise ValueError("invalid build result identity")
    workspace = os.path.normpath(workspace)
    root = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY)
    try:
        with private(root, ".spec-runs", True) as runs, private(runs, "run-" + run_id, True) as run:
            if read(run, "status", 4) != b"0\n":
                raise ValueError("build result requires successful status")
            fields = read(run, "provenance", 16384).split(b"\0")
            expected = [os.fsencode(workspace), b"build", os.fsencode(name),
                        os.fsencode(os.path.join(workspace, ".spec-runs", "run-" + run_id, name + ".out")), b""]
            if (len(fields) != 5 or fields[1] not in (b"build", b"continue")
                    or fields[0] != expected[0] or fields[2:] != expected[2:]):
                raise ValueError("build result provenance mismatch")
            stage = read(run, "stage", 11)
            if stage not in (b"builder\n", b"integrator\n"):
                raise ValueError("invalid build result stage metadata")
            value = json.loads(read(run, "result.json", LIMIT * 6 + 1024).decode("utf-8"), object_pairs_hook=unique)
            if (not isinstance(value, dict) or set(value) != {"version", "stage", "report"}
                    or type(value["version"]) is not int or value["version"] != 1
                    or value["stage"] != stage.decode().strip()
                    or not isinstance(value["report"], str) or not value["report"].strip()
                    or len(value["report"].encode("utf-8")) > LIMIT):
                raise ValueError("invalid build result envelope")
            print(json.dumps(value, ensure_ascii=True))
    finally:
        os.close(root)


try:
    main()
except (OSError, ValueError, TypeError, RecursionError):
    print("[remote] Missing, unsafe, mismatched, or invalid successful build result.", file=sys.stderr)
    sys.exit(125)
