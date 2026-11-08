"""Offline tests with synthetic values only; no interactive prompts or provider calls."""

import contextlib
import io
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings

import setup_marketplace as setup


def values():
    return dict(zip((key for key, _, _ in setup.FIELDS), (
        "test-only-token", "example/private-skills", "main", "test-client",
        "test-only-secret", "TESTMERCHANT", "https://example.test/spec", "sandbox",
    )))


class ValidationTests(unittest.TestCase):
    def test_public_examples_serialization_is_explicit_and_narrow(self):
        public = values()
        public.pop("SPEC_SKILLS_GITHUB_TOKEN")
        public["SPEC_SKILLS_GITHUB_REPO"] = "AI10x/skills-marketplace-examples"
        public["SPEC_SKILLS_PUBLIC_EXAMPLES"] = "1"
        data = setup.serialize(public)
        self.assertNotIn(b"SPEC_SKILLS_GITHUB_TOKEN", data)
        self.assertIn(b"SPEC_SKILLS_PUBLIC_EXAMPLES='1'", data)
        for changes in ({"SPEC_PAYPAL_MODE": "live"}, {"SPEC_SKILLS_GITHUB_REPO": "other/repo"},
                        {"SPEC_SKILLS_GITHUB_TOKEN": "ignored-secret"}, {"SPEC_SKILLS_PUBLIC_EXAMPLES": "0"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                setup.serialize(dict(public, **changes))
        public.pop("SPEC_SKILLS_PUBLIC_EXAMPLES")
        with self.assertRaises(ValueError):
            setup.serialize(public)

    def test_valid_configuration_and_modes(self):
        for key, value in values().items():
            self.assertEqual(setup.validate(key, value), value)
        self.assertEqual(setup.validate("SPEC_PAYPAL_MODE", "live"), "live")
        for url in ("https://localhost:8443/", "https://[::1]:443/path", "https://example.test/a%20b"):
            setup.validate("SPEC_PAYPAL_RETURN_URL", url)
        setup.validate("SPEC_SKILLS_GITHUB_REF", "release/v1.0")

    def test_no_whitespace_controls_empty_or_unicode(self):
        for key in values():
            for value in ("", " a", "a ", "a\nb", "a\rb", "a\tb", "a\x00", "a\x7f", "a\u00e9", "a" * 4097):
                with self.subTest(key=key), self.assertRaises(ValueError):
                    setup.validate(key, value)

    def test_structured_validation(self):
        cases = {
            "SPEC_SKILLS_GITHUB_REPO": ("https://github.com/a/b", "a", "a/b/c", "../a", "a/" + "b" * 101),
            "SPEC_SKILLS_GITHUB_REF": ("../main", "a//b", "main.lock", "-main", "main.", "a" * 201, "$(id)"),
            "SPEC_PAYPAL_MERCHANT_ID": ("a@b.test", "..", "a" * 101),
            "SPEC_PAYPAL_MODE": ("LIVE", "demo", "yes"),
            "SPEC_PAYPAL_RETURN_URL": ("http://example.test", "https://a:b@example.test", "https://@example.test", "https://example.test?", "https://example.test#", "https://example.test/\\x", "https://", "https://x:65536", "https://x:bad", "https://[::1]garbage", "https://%zz", "https://a..b", "https://x/%zz"),
        }
        for key, bad in cases.items():
            for value in bad:
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    setup.validate(key, value)
        for changed in ({}, dict(values(), BAD="injected")):
            with self.assertRaises(ValueError):
                setup.serialize(changed)

    def test_quoting_round_trip_shell_without_execution(self):
        config = values()
        # Apostrophes, dollars, backticks, quotes and backslashes remain literal.
        config["SPEC_PAYPAL_CLIENT_SECRET"] = "test'\"\\$HOME${HOME}`false`$(false);#=end\\"
        data = setup.serialize(config)
        result = subprocess.run(["/bin/sh", "-c", data.decode() + '\nprintf "%s" "$SPEC_PAYPAL_CLIENT_SECRET"'],
                                capture_output=True, check=True)
        self.assertEqual(result.stdout.decode(), config["SPEC_PAYPAL_CLIENT_SECRET"])
        self.assertEqual(result.stderr, b"")

    def test_quoting_round_trip_actual_rust_dotenvy(self):
        libraries = list((setup.ROOT / "backend/target/debug/deps").glob("libdotenvy-*.rlib"))
        if not libraries or not shutil.which("rustc"):
            self.skipTest("Build backend first; Rust/dotenvy artifact required for actual loader check")
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "dotenv-check"
            subprocess.run(["rustc", "--edition=2021", str(Path(__file__).with_name("marketplace_dotenv_check.rs")),
                            "--extern", "dotenvy=" + str(libraries[0]), "-o", str(binary)], check=True, capture_output=True)
            fixtures = ["".join(chr(c) for c in range(33, 127)), "'$HOME'", "\\", "''", "${HOME}$(false)`false`", "x" * 4096]
            fixtures += [chr(c) for c in range(33, 127)]
            fixtures += [a + b for a in "'\\\"$`#" for b in "'\\\"$`#"]
            for fixture in fixtures:
                config = values()
                config["SPEC_PAYPAL_CLIENT_SECRET"] = fixture
                expected = "\n".join(key + "=" + config[key] for key, _, _ in setup.FIELDS)
                result = subprocess.run([str(binary)], input=expected.encode() + b"\n\n" + setup.serialize(config), capture_output=True)
                self.assertEqual(result.returncode, 0, "dotenvy round-trip failed")
                self.assertEqual(result.stdout + result.stderr, b"")


class InterviewTests(unittest.TestCase):
    def run_interview(self, answers):
        with patch.object(sys.stdin, "isatty", return_value=True), patch.object(sys.stderr, "isatty", return_value=True), \
                patch.object(setup.getpass, "getpass", side_effect=answers), \
                patch("builtins.input", side_effect=AssertionError("echoing input forbidden")):
            return setup.collect()

    def test_default_sandbox_ref_and_explicit_save(self):
        answers = list(values().values())
        answers[2] = answers[-1] = ""
        self.assertEqual(self.run_interview(answers + ["SAVE"]), values())

    def test_live_requires_exact_extra_confirmation(self):
        answers = list(values().values())
        answers[-1] = "live"
        for answer in ("", "yes", "enable live payments"):
            with self.assertRaises(ValueError):
                self.run_interview(answers + [answer])
        self.assertEqual(self.run_interview(answers + ["ENABLE LIVE PAYMENTS", "SAVE"])["SPEC_PAYPAL_MODE"], "live")
        with self.assertRaises(ValueError):
            self.run_interview(list(values().values()) + [""])

    def test_warning_fails_before_echo_fallback(self):
        def fallback(*args, **kwargs):
            warnings.warn("cannot disable echo", setup.getpass.GetPassWarning)
            self.fail("echo fallback reached")
        with self.assertRaises(setup.getpass.GetPassWarning):
            self.run_interview(fallback)

    def test_noninteractive_refusal_and_argument_redaction(self):
        script = str(Path(__file__).with_name("setup_marketplace.py"))
        for args in ([], ["--secret", "synthetic-never-print"]):
            result = subprocess.run([sys.executable, script] + args, input=b"synthetic-never-print\n", capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b"")
            self.assertNotIn(b"synthetic-never-print", result.stderr)

    def test_each_terminal_stream_is_required(self):
        for stdin, stderr in ((False, True), (True, False), (False, False)):
            with patch.object(sys.stdin, "isatty", return_value=stdin), \
                    patch.object(sys.stderr, "isatty", return_value=stderr), \
                    patch.object(setup.getpass, "getpass") as prompt, self.assertRaises(ValueError):
                setup.hidden("Test")
            prompt.assert_not_called()

    def test_successful_main_writes_without_printing_values(self):
        out, err = io.StringIO(), io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private" / "marketplace.env"
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                    patch.object(sys.stdin, "isatty", return_value=True), patch.object(err, "isatty", return_value=True), \
                    patch.object(setup.getpass, "getpass", side_effect=list(values().values()) + ["SAVE"]):
                self.assertEqual(setup.main(["--output", str(path)]), 0)
            self.assertEqual(path.read_bytes(), setup.serialize(values()))
        self.assertEqual(out.getvalue(), "")
        for key in ("SPEC_SKILLS_GITHUB_TOKEN", "SPEC_PAYPAL_CLIENT_ID", "SPEC_PAYPAL_CLIENT_SECRET"):
            self.assertNotIn(values()[key], err.getvalue())

    def test_cancellation_failures_do_not_write_or_print_values(self):
        for error in (KeyboardInterrupt(), EOFError(), OSError("synthetic-never-print"), setup.getpass.GetPassWarning()):
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                    patch.object(sys.stdin, "isatty", return_value=True), patch.object(err, "isatty", return_value=True), \
                    patch.object(setup.getpass, "getpass", side_effect=["synthetic-never-print", error]), \
                    patch.object(setup, "write_private") as write:
                self.assertEqual(setup.main([]), 1)
            write.assert_not_called()
            self.assertEqual(out.getvalue(), "")
            self.assertNotIn("synthetic-never-print", err.getvalue())


class FileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "private" / "marketplace.env"

    def test_private_permissions_and_contents(self):
        old = os.umask(0)
        try:
            setup.write_private(self.path, setup.serialize(values()))
        finally:
            os.umask(old)
        self.assertEqual(stat.S_IMODE(self.path.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(self.path.read_bytes(), setup.serialize(values()))
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_existing_file_directory_and_symlink_are_untouched(self):
        self.path.parent.mkdir(mode=0o700)
        target = self.root / "target"
        target.write_bytes(b"unchanged")
        for kind in ("file", "directory", "symlink", "dangling"):
            with self.subTest(kind=kind):
                if kind == "file":
                    self.path.write_bytes(b"unchanged")
                elif kind == "directory":
                    self.path.mkdir()
                else:
                    self.path.symlink_to(target if kind == "symlink" else self.root / "absent")
                with self.assertRaises(ValueError):
                    setup.write_private(self.path, b"new")
                self.assertEqual(target.read_bytes(), b"unchanged")
                if kind == "directory":
                    self.path.rmdir()
                else:
                    if kind == "file":
                        self.assertEqual(self.path.read_bytes(), b"unchanged")
                    self.path.unlink()

    def test_parent_and_ancestor_symlinks_refused(self):
        real = self.root / "real"
        real.mkdir(mode=0o700)
        alias = self.root / "alias"
        alias.symlink_to(real, target_is_directory=True)
        for path in (alias / "file.env", alias / "new" / "file.env"):
            with self.assertRaises(OSError):
                setup.write_private(path, b"new")
        self.assertEqual(list(real.iterdir()), [])

    def test_unsafe_parent_or_ancestor_never_chmodded(self):
        self.path.parent.mkdir(mode=0o755)
        self.path.parent.chmod(0o755)
        with self.assertRaises(ValueError):
            setup.write_private(self.path, b"new")
        self.assertEqual(stat.S_IMODE(self.path.parent.stat().st_mode), 0o755)
        self.path.parent.chmod(0o777)
        with self.assertRaises(ValueError):
            setup.write_private(self.path.parent / "new" / "file.env", b"new")
        self.assertFalse((self.path.parent / "new").exists())

    def test_public_paths_and_traversal_refused(self):
        workspace, ui = self.root / "workspace", self.root / "ui"
        for path in ("relative.env", "/" + str(setup.ROOT / "private/file"), str(self.root / ".." / "file"), workspace / "file", ui / "file", setup.ROOT / "private/file"):
            with self.assertRaises(ValueError):
                setup.output_path(str(path), workspace, ui)
        self.assertEqual(setup.output_path(str(self.path), workspace, ui), self.path)

    def test_missing_ancestor_is_not_created(self):
        with self.assertRaises(ValueError):
            setup.write_private(self.root / "missing" / "private" / "file.env", b"synthetic")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_failed_write_and_cancel_leave_no_partial_or_temporary(self):
        for error in (OSError(), KeyboardInterrupt()):
            with patch.object(setup.os, "fsync", side_effect=error), self.assertRaises(type(error)):
                setup.write_private(self.path, b"synthetic")
            self.assertEqual(list(self.path.parent.iterdir()), [])

    def test_publication_race_never_overwrites(self):
        def competing_file(*args, **kwargs):
            self.path.write_bytes(b"other-writer")
            raise FileExistsError()
        with patch.object(setup.os, "link", side_effect=competing_file), self.assertRaises(FileExistsError):
            setup.write_private(self.path, b"synthetic")
        self.assertEqual(self.path.read_bytes(), b"other-writer")
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_final_sync_failure_leaves_only_complete_file(self):
        data = setup.serialize(values())
        with patch.object(setup.os, "fsync", side_effect=[None, OSError()]), self.assertRaises(OSError):
            setup.write_private(self.path, data)
        self.assertEqual(self.path.read_bytes(), data)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])


if __name__ == "__main__":
    unittest.main()
