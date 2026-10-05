#!/usr/bin/env python3
"""Linux/macOS smoke test; build first, then optionally pass the kibi binary path."""
import contextlib
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import traceback


class Terminal:
    def __init__(self, binary, root, name, color=False, persistent=False):
        self.root, self.pending, self.screen, self.trace = root, b"", "", b""
        self.fd, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        # No inherited credentials/config, and python3 cannot start the completion agent.
        env = dict(HOME=str(root), XDG_CONFIG_HOME=str(root), XDG_CONFIG_DIRS=str(root),
                   XDG_DATA_HOME=str(root), XDG_DATA_DIRS=str(root), TERM="xterm", NO_COLOR="" if color else "1",
                   PATH=str(root / "bin"), TMPDIR=str(root),
                    KIBI_RUN_COMMAND=str(root / "runner ; literal"),
                    KIBI_SPEC_SESSION="1" if persistent else "0")
        try:
            self.proc = subprocess.Popen([str(binary)] + ([name] if name else []), cwd=root,
                                         env=env, stdin=slave, stdout=slave, stderr=slave,
                                         start_new_session=True)
        except OSError:
            os.close(self.fd)
            raise
        finally:
            os.close(slave)
        os.set_blocking(self.fd, False)

    def send(self, keys):
        self.screen = ""
        data = keys.encode()
        while data:
            _, ready, _ = select.select([], [self.fd], [], 10)
            assert ready, "PTY write timeout"
            data = data[os.write(self.fd, data):]

    def wait(self, text):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            assert self.proc.poll() is None, f"editor exited: {self.trace[-3000:]!r}"
            if text in self.screen and self.screen:
                return self.screen
            if not select.select([self.fd], [], [], 0.05)[0]:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            assert chunk, f"PTY closed: {self.trace[-3000:]!r}"
            self.trace = (self.trace + chunk)[-16000:]
            frames = (self.pending + chunk).split(b"\x1b[?25h")
            self.pending = frames[-1]
            if len(frames) > 1:
                self.screen = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", frames[-2]).decode("utf-8", "replace")
        raise AssertionError(f"waiting for {text!r}: {self.trace[-3000:]!r}")

    def resize(self, cols, rows=24):
        self.screen = ""
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.proc.send_signal(signal.SIGWINCH)
        self.wait("")

    def calls(self):
        path = self.root / "calls"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def close(self):
        if self.proc.poll() is None:
            with contextlib.suppress(OSError):
                self.send("\x11" * 4)
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
                self.proc.wait(timeout=2)
        os.close(self.fd)
        # Output jobs use their own process group; also clean up after editor panics.
        for call in self.calls():
            with contextlib.suppress(ProcessLookupError):
                os.killpg(call[0], signal.SIGKILL)


@contextlib.contextmanager
def editor(binary, name=None, content="", color=False, persistent=False):
    with tempfile.TemporaryDirectory(prefix="kibi-pty-") as directory:
        root = Path(directory).resolve()
        (root / "bin").mkdir()
        (root / "bin/bash").symlink_to(shutil.which("bash"))
        (root / "bin/nohup").symlink_to(shutil.which("nohup"))
        stub = root / "bin/python3"
        stub.write_text("#!/bin/sh\nexit 0\n")
        stub.chmod(0o755)
        runner = root / "runner ; literal"
        runner.write_text(f"#!{sys.executable}\n" + '''import json, os, pathlib, select, sys, time
root = pathlib.Path.cwd()
with (root / "calls").open("a") as log:
    log.write(json.dumps([os.getpid(), sys.argv[1:], pathlib.Path(sys.argv[1]).read_text()]) + "\\n")
print("LIVE-OUT", flush=True)
print("LIVE-ERR", file=sys.stderr, flush=True)
deadline = time.monotonic() + 20
inbox = pathlib.Path(os.environ["SPEC_SESSION_DIR"]) if os.environ.get("SPEC_SESSION_DIR") else None
# Match the existing runner liveness protocol checked before publishing updates.
if inbox:
    (inbox / ".runner").mkdir(exist_ok=True)
    (inbox / ".runner/pid").write_text(json.dumps(os.getpid()))
    (inbox / ".runner/status").write_text(json.dumps({"state": "ready"}))
seen = set()
while not (root / "release").exists():
    if inbox:
        for message in sorted(inbox.glob("*.json")):
            if message.name in seen:
                continue
            seen.add(message.name)
            with (root / "updates").open("a") as log:
                log.write(json.dumps(json.loads(message.read_text())) + "\\n")
            print("UPDATE-" + str(len(seen)), flush=True)
    if time.monotonic() > deadline:
        sys.exit(99)
    select.select([], [], [], 0.02)
print("FINISHED", flush=True)
''')
        runner.chmod(0o755)
        if name:
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_text(content)
        terminal = Terminal(binary, root, name, color=color, persistent=persistent)
        try:
            terminal.wait("Output | Idle")
            yield terminal
        finally:
            terminal.close()


def named(binary):
    name = "spec ;$(touch INJECTED) ' &.txt"
    with editor(binary, name, "old\nkeep\n") as t:
        t.send("\x0blatest\x12")  # Ctrl+K deletes the old line, Ctrl+R saves/runs.
        t.wait("LIVE-ERR")
        screen = t.wait("LIVE-OUT")
        assert screen.splitlines()[0].startswith("Output | Running")
        assert "latestkeep" in screen.splitlines()[0][40:], "document must be in right pane"
        assert not (t.root / "release").exists(), "output must arrive before child exit"
        assert t.calls()[0][1:] == [[str(t.root / name)], "latestkeep\n"], t.calls()
        assert (t.root / name).read_text() == "latestkeep\n"
        t.send("+edit\x13")
        t.wait("16B written to")
        assert (t.root / name).read_text() == "latest+editkeep\n", "editor blocked during run"
        t.send("\x12")
        t.wait("already running")
        t.send("\x05printf forbidden > forbidden\r")
        t.wait("already running")
        (t.root / "release").touch()
        t.wait("Exited:")
        assert len(t.calls()) == 1 and not (t.root / "forbidden").exists()
        assert not (t.root / "INJECTED").exists(), "filename was interpreted by a shell"
        t.send("\x05printf 'SHELL-%s\\n' OUT; printf 'SHELL-%s\\n' ERR >&2; exit 7\r")
        t.wait("exit status: 7")
        assert "\r\nSHELL-OUT" in t.screen and "\r\nSHELL-ERR" in t.screen
        assert (t.root / (name + ".out")).read_text() == (
            "LIVE-OUT\nLIVE-ERR\nFINISHED\nSHELL-OUT\nSHELL-ERR\n"
        ), "build and shell output must append to the same log"
        assert "LIVE-OUT" not in t.screen, "pane retained output from the previous run"
        t.send("\x13")
        t.wait("written to")
        assert (t.root / name).read_text() == "latest+editkeep\n", "shell output entered document"
        t.resize(40)
        t.resize(2, 2)
        t.resize(80)
        t.send("!\x13")
        t.wait("17B written to")
        assert (t.root / name).read_text() == "latest+edit!keep\n"


def unnamed(binary):
    with editor(binary) as t:
        t.send("new spec\x12")
        t.wait("Save and run as: ")
        t.send("\x1b")
        t.wait("aborted")
        assert not t.calls(), "cancel executed runner"
        t.send("\x12saved spec.txt\r")
        t.wait("LIVE-ERR")
        assert t.calls()[0][1:] == [[str(t.root / "saved spec.txt")], "new spec"]
        (t.root / "release").touch()
        t.wait("Exited:")
        assert len(t.calls()) == 1
        assert (t.root / "saved spec.txt.out").read_text() == "LIVE-OUT\nLIVE-ERR\nFINISHED\n"


def persistent_updates(binary):
    with editor(binary, "spec", "original\n", persistent=True) as t:
        t.send("\x12")
        t.wait("UPDATE-1")
        pid = t.calls()[0][0]
        t.send("changed\x12")
        t.wait("UPDATE-2")
        assert (t.root / "spec").read_text() == "changedoriginal\n"
        t.send(" again\x12\x12")
        t.wait("UPDATE-4")
        updates = [json.loads(line)["text"] for line in (t.root / "updates").read_text().splitlines()]
        assert updates == ["original\n", "changedoriginal\n", "changed againoriginal\n", "changed againoriginal\n"]
        assert len(t.calls()) == 1 and t.calls()[0][0] == pid, "Ctrl+R restarted the session"
        assert "LIVE-OUT" in t.screen, "update cleared the output pane"
        t.send("\x05printf forbidden > forbidden\r")
        t.wait("already running")
        assert not (t.root / "forbidden").exists()
        (t.root / "spec").unlink()
        (t.root / "spec").mkdir()
        t.send("unsaved\x12")
        t.wait("Can't save!")
        time.sleep(0.1)
        assert len((t.root / "updates").read_text().splitlines()) == 4
        inboxes = list((t.root / ".local/state/spec/sessions").iterdir())
        assert len(inboxes) == 1 and inboxes[0].stat().st_mode & 0o777 == 0o700
        t.send("\x11" * 4)
        t.proc.wait(timeout=2)
        os.kill(pid, 0)
        (t.root / "release").touch()


def log_destination(binary):
    with editor(binary, "nested/plan.md", "spec") as t:
        t.send("\x12")
        t.wait("LIVE-ERR")
        assert (t.root / "plan.md.out").read_text() == "LIVE-OUT\nLIVE-ERR\n"
        assert not (t.root / "nested/plan.md.out").exists()
        (t.root / "release").touch()
        t.wait("Exited:")
    with editor(binary) as t:
        t.send("\x05printf unnamed; printf error >&2\r")
        t.wait("Exited:")
        assert (t.root / "untitled.out").read_text() == "unnamederror"
    with editor(binary, "spec", "original") as t:
        (t.root / "spec.out").mkdir()
        t.send("\x12")
        t.wait("Can't run command:")
        assert not t.calls(), "runner started despite log open failure"


def save_failure(binary):
    with editor(binary, "spec", "original") as t:
        (t.root / "spec").unlink()
        (t.root / "spec").mkdir()  # Deterministic even when tests run as root.
        t.send("changed\x12")
        t.wait("Can't save!")
        t.send("\x05printf 'BARRIER-%s' OK\r")
        t.wait("Exited:")
        assert "BARRIER-OK" in t.screen and not t.calls(), "failed save executed runner"


def filename_picker(binary):
    for hotkey in ("\x1b[58;6u", "\x1b[27;6;58~", "\x14"):
        with editor(binary, "spec", "config\nkeep this line") as t:
            (t.root / "config.rs").write_text("opened target")
            (t.root / "config-extra.rs").write_text("second target")
            t.send(hotkey)
            t.wait("File query: ")
            assert "Ranked filenames" not in t.screen, "search ran before query submission"
            t.send("config" + hotkey)
            t.wait("Ranked filenames")
            assert "config.rs" in t.screen and "config-extra.rs" in t.screen
            t.send("\r\x13")
            t.wait("written to")
            assert (t.root / "spec").read_text() == "config\nconfig.rs\nkeep this line\n"
    with editor(binary, "spec", "config") as t:
        (t.root / "config.rs").write_text("opened target")
        (t.root / "config-extra.rs").write_text("second target")
        t.send("\x14")
        t.wait("File query: ")
        t.send("config\r")
        t.wait("Ranked filenames")
        t.send("\x1b[B\x0f")
        t.wait("Opened config-extra.rs")
        t.send("X\x13")
        t.wait("written to")
        assert (t.root / "config-extra.rs").read_text() == "Xsecond target"
        assert (t.root / "spec").read_text() == "config"
    with editor(binary, "spec", "config") as t:
        (t.root / "config.rs").write_text("opened target")
        t.send("x\x14")
        t.wait("File query: ")
        t.send("no-such-file\r")
        t.wait("No matching filenames")
        t.send("\x14config\r")
        t.wait("Ranked filenames")
        t.send("\x0f")
        t.wait("Unsaved changes")
        assert (t.root / "config.rs").read_text() == "opened target"
        (t.root / "spec").rename(t.root / "spec-backup")
        (t.root / "spec").mkdir()
        t.send("\x13")
        t.wait("Can't save!")
        t.send("\x0f")
        t.wait("Unsaved changes")
        assert (t.root / "config.rs").read_text() == "opened target"
        (t.root / "spec").rmdir()
        (t.root / "spec-backup").rename(t.root / "spec")
        t.send("\x13")
        t.wait("written to")
        assert (t.root / "spec").read_text() == "xconfig\n"
        t.send("\x0f")
        t.wait("Opened config.rs")
        t.send("Y\x13")
        t.wait("written to")
        assert (t.root / "config.rs").read_text() == "Yopened target"


def filename_open_running(binary):
    for persistent in (False, True):
        with editor(binary, "spec", "original\n", persistent=persistent) as t:
            (t.root / "target.rs").write_text("first target")
            target = t.root / "target-extra.rs"
            target.write_bytes(b"\x00binary")
            t.send("\x12")
            t.wait("UPDATE-1" if persistent else "LIVE-ERR")
            pid = t.calls()[0][0]
            inboxes = list((t.root / ".local/state/spec/sessions").glob("*"))
            t.send("\x14target\r")
            t.wait("Ranked filenames")
            t.send("2\x0f")
            t.wait("Cannot open filename")
            os.kill(pid, 0)
            # Failure must preserve the session, not only the document.
            t.send("\x1b")
            t.wait("Filename selection cancelled")
            if persistent:
                t.send("\x12")
                t.wait("UPDATE-2")
                assert len(t.calls()) == 1
            target.write_text("second target")
            t.send("\x14target\r")
            t.wait("Ranked filenames")
            t.send("2\x0f")
            t.wait("Opened target-extra.rs")
            assert "previous build detached" in t.screen
            os.kill(pid, 0)
            if persistent:
                # The previous session must be available for another editor to restore.
                with (inboxes[0] / ".editor-lock").open() as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            t.send("X\x12")
            t.wait("UPDATE-1" if persistent else "LIVE-ERR")
            assert len(t.calls()) == 2, "new file was sent to the previous build"
            assert t.calls()[1][1:] == [[str(target)], "Xsecond target"]
            assert (t.root / "spec").read_text() == "original\n"
            if persistent:
                assert all(json.loads(p.read_text())["text"] == "original\n"
                           for p in inboxes[0].glob("*.json"))
            # Both detached and current jobs still finish and flush their own logs.
            (t.root / "release").touch()
            t.wait("Exited:")
            deadline = time.monotonic() + 5
            while "FINISHED" not in (t.root / "spec.out").read_text():
                assert time.monotonic() < deadline, "detached build lost its output"
                time.sleep(0.02)
            assert "FINISHED" in (t.root / "target-extra.rs.out").read_text()


def filename_query(binary):
    with editor(binary, "spec", "document stays untouched\n") as t:
        (t.root / "配置.rs").write_text("unicode target")
        t.send("\x14")
        t.wait("File query: ")
        t.send("\r")
        t.wait("File query: ")
        t.send("cancel this\x1b")
        t.wait("Filename search cancelled")
        t.send("\x13")
        t.wait("written to")
        assert (t.root / "spec").read_text() == "document stays untouched\n"
        t.send("\x14" + "long query " * 30)
        t.wait("File query: ")
        t.resize(32)
        t.send("\x15配置x\x7f")
        t.wait("File query: 配置")
        t.resize(80)
        t.send("\r")
        t.wait("Ranked filenames")
        assert "配置.rs" in t.screen
        t.send("\x0f")
        t.wait("Opened 配置.rs")
        t.send("X\x13")
        t.wait("written to")
        assert (t.root / "配置.rs").read_text() == "Xunicode target"
        assert (t.root / "spec").read_text() == "document stays untouched\n"


def unicode_resize(binary):
    with editor(binary, "ab" + "\u20ac" * 20, "text") as t:
        t.resize(40)
        t.resize(2, 2)
        t.resize(80)


def unicode_save(binary):
    with editor(binary, "a" * 20 + "\u20ac" * 16, "text") as t:
        t.send("\x13")
        t.wait("written to")


def background_survives_exit(binary):
    for keys, hangup in (("\x12", False), ("\x12", True),
                         ("\x05exec './runner ; literal' spec\r", False),
                         ("\x05exec './runner ; literal' spec\r", True)):
        with editor(binary, "spec", "background") as t:
            t.send(keys)
            t.wait("LIVE-ERR")
            pid = t.calls()[0][0]
            if hangup:
                t.proc.send_signal(signal.SIGHUP)
            else:
                t.send("\x11")
            t.proc.wait(timeout=2)
            os.killpg(pid, signal.SIGHUP)
            (t.root / "release").touch()
            log = t.root / "spec.out"
            deadline = time.monotonic() + 5
            while "FINISHED" not in log.read_text():
                assert time.monotonic() < deadline, "background output stopped after editor exit"
                time.sleep(0.02)
            assert log.stat().st_mode & 0o777 == 0o600, "log must be private"


if __name__ == "__main__":
    binary = Path(sys.argv[1] if len(sys.argv) > 1 else
                  Path(__file__).resolve().parents[1] / "editor/target/debug/kibi").resolve()
    failures = 0
    for test in (filename_open_running, filename_query, filename_picker, named, unnamed, persistent_updates, log_destination, save_failure, unicode_resize, unicode_save,
                 background_survives_exit):
        try:
            test(binary)
            print(f"PASS {test.__name__}", flush=True)
        except Exception:
            failures += 1
            print(f"FAIL {test.__name__}", flush=True)
            traceback.print_exc()
    sys.exit(bool(failures))
