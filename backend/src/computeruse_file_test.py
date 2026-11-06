import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("computeruse-file.py")
spec = importlib.util.spec_from_file_location("shared", SCRIPT)
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


class SharedFileTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.path = self.root / "a ' $(touch INJECTED); \".txt"

    def call(self, operation="read", **kwargs):
        data = {"operation": operation, "path": str(self.path), **kwargs}
        result = subprocess.run(["python3", "-I", "-B", "-c", SCRIPT.read_text()],
                                input=json.dumps(data).encode(), capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        return json.loads(result.stdout)

    def test_exact_text_missing_and_stale_cas(self):
        self.assertEqual(self.call(), {"content": "", "revision": None})
        content = "\r\n  ' $(false) `false` \\ \t \u2603\n\n"
        revision = hashlib.sha256(content.encode()).hexdigest()
        self.assertEqual(self.call("write", content=content, revision=None),
                         {"content": content, "revision": revision})
        self.assertEqual(self.path.read_bytes(), content.encode())
        self.assertEqual(self.call()["content"], content)
        self.assertEqual(self.call("write", content="bad", revision=None)["status"], 409)
        self.assertEqual(self.call("write", content="next", revision=revision)["content"], "next")
        self.assertFalse((self.root / "INJECTED").exists())

    def test_unsafe_files_for_read_and_write(self):
        outside = self.root / "outside"
        outside.write_text("safe")
        for kind in ("symlink", "hardlink", "directory", "fifo"):
            if kind == "symlink":
                self.path.symlink_to(outside)
            elif kind == "hardlink":
                os.link(outside, self.path)
            elif kind == "directory":
                self.path.mkdir()
            else:
                os.mkfifo(self.path)
            self.assertEqual(self.call()["status"], 400, kind)
            self.assertEqual(self.call("write", content="bad", revision=None)["status"], 400, kind)
            self.path.rmdir() if kind == "directory" else self.path.unlink()
        self.assertEqual(outside.read_text(), "safe")

    def test_size_utf8_nul_and_boundary(self):
        for data in (b"\0", b"\xff", b"x" * (shared.LIMIT + 1)):
            self.path.write_bytes(data)
            self.assertEqual(self.call()["status"], 400)
        self.path.unlink()
        for content in ("\0", "x" * (shared.LIMIT + 1)):
            self.assertEqual(self.call("write", content=content, revision=None)["status"], 400)
        content = "x" * shared.LIMIT
        self.assertEqual(self.call("write", content=content, revision=None)["content"], content)

    def test_parent_symlink_permissions_and_missing_parent(self):
        link = self.root / "link"
        link.symlink_to(self.root, target_is_directory=True)
        self.assertEqual(self.call(path=str(link / "file"))["status"], 400)
        parent = self.root / "unsafe"
        parent.mkdir(mode=0o777)
        parent.chmod(0o777)
        self.assertEqual(self.call(path=str(parent / "file"))["status"], 400)
        self.assertEqual(self.call(path=str(self.root / "missing" / "file"))["status"], 400)
        self.assertEqual(self.call(path="relative")["status"], 400)

    def test_writer_lock_and_simultaneous_cas(self):
        import fcntl
        lock = self.root / (".computeruse-lock-" + hashlib.sha256(self.path.name.encode()).hexdigest())
        with lock.open("w") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.call("write", content="no", revision=None)["status"], 409)
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda value: self.call("write", content=value, revision=None), ["a", "b"]))
        self.assertEqual(sum("content" in result for result in results), 1)
        self.assertEqual(sum(result.get("status") == 409 for result in results), 1)


if __name__ == "__main__":
    unittest.main()
