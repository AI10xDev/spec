"""Fixed shared-file protocol. Paths and operations arrive only as JSON on stdin."""
import fcntl
import hashlib
import json
import os
import signal
import stat
import sys
import uuid

LIMIT = 2 * 1024 * 1024


class Failure(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def regular(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise Failure(400, "Shared file must be a single-link regular file")
    return info


def parent(path):
    if not isinstance(path, str) or not path.startswith("/") or "\0" in path:
        raise Failure(400, "Expected an absolute shared-file path")
    parts = path.split("/")[1:]
    if not parts or any(p in ("", ".", "..") for p in parts):
        raise Failure(400, "Invalid shared-file path")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for index, part in enumerate(parts[:-1]):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            # Root-owned sticky ancestors (e.g. /tmp) are safe, not final parents.
            sticky = info.st_uid == 0 and info.st_mode & stat.S_ISVTX and index < len(parts) - 2
            if info.st_uid not in (0, os.geteuid()) or (info.st_mode & 0o022 and not sticky):
                raise Failure(400, "Unsafe shared-file parent")
        return fd, parts[-1]
    except BaseException:
        os.close(fd)
        raise


def read_at(fd, name):
    try:
        source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        return {"content": "", "revision": None}
    with os.fdopen(source, "rb") as stream:
        if regular(stream.fileno()).st_size > LIMIT:
            raise Failure(400, "Shared file exceeds 2 MiB")
        data = stream.read(LIMIT + 1)
    if len(data) > LIMIT or b"\0" in data:
        raise Failure(400, "Shared file exceeds 2 MiB or contains NUL")
    content = data.decode("utf-8", errors="strict")
    return {"content": content, "revision": hashlib.sha256(data).hexdigest()}


def exchange(request):
    fd, name = parent(request["path"])
    try:
        if request["operation"] == "read":
            return read_at(fd, name)
        if request["operation"] != "write":
            raise Failure(400, "Invalid shared-file operation")
        content = request["content"]
        data = content.encode("utf-8", errors="strict")
        if len(data) > LIMIT or b"\0" in data:
            raise Failure(400, "Shared file exceeds 2 MiB or contains NUL")
        # Cooperative CAS: every writer must hold this persistent sidecar flock
        # across revision checking, replacement and directory fsync. Never unlink it.
        lock_name = ".computeruse-lock-" + hashlib.sha256(name.encode()).hexdigest()
        lock = os.open(lock_name, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
        with os.fdopen(lock, "wb") as locked:
            regular(locked.fileno())
            try:
                fcntl.flock(locked, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Failure(409, "Shared-file writer is busy")
            if read_at(fd, name)["revision"] != request["revision"]:
                raise Failure(409, "Remote shared file changed; fetch it before retrying")
            temporary = ".computeruse-" + uuid.uuid4().hex
            try:
                target = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                with os.fdopen(target, "wb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                # Best-effort recheck for noncooperating writers, not a CAS guarantee.
                if read_at(fd, name)["revision"] != request["revision"]:
                    raise Failure(409, "Remote shared file changed during write")
                os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
                os.fsync(fd)
            finally:
                try:
                    os.unlink(temporary, dir_fd=fd)
                except FileNotFoundError:
                    pass
        return {"content": content, "revision": hashlib.sha256(data).hexdigest()}
    finally:
        os.close(fd)


def main():
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(Failure(504, "Shared-file operation timed out")))
    signal.alarm(20)
    try:
        data = sys.stdin.buffer.read(LIMIT * 6 + 4097)
        if len(data) > LIMIT * 6 + 4096:
            raise Failure(400, "Request exceeds limit")
        response = exchange(json.loads(data))
    except Failure as error:
        response = {"error": str(error), "status": error.status}
    except (OSError, ValueError, KeyError, TypeError) as error:
        response = {"error": "Unsafe or invalid shared file: " + str(error), "status": 400}
    print(json.dumps(response, ensure_ascii=True))


if __name__ == "__main__":
    main()
