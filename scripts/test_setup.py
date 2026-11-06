"""Offline wizard tests; only generated launchers execute, against a temporary stub."""

import contextlib
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import call, patch

import setup


class TemporarySetupTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(dir="/tmp")))
        self.stack.enter_context(patch.object(setup, "ROOT", self.root))
        self.stack.enter_context(patch.dict(os.environ, {
            "HOME": str(self.root), "PATH": os.defpath, "LC_ALL": "C",
        }, clear=True))
        self.stack.enter_context(patch("socket.socket", side_effect=AssertionError("network forbidden")))
        self.stdout, self.stderr = io.StringIO(), io.StringIO()
        self.stack.enter_context(contextlib.redirect_stdout(self.stdout))
        self.stack.enter_context(contextlib.redirect_stderr(self.stderr))
        self.env = {
            "SPEC_WORKSPACE": str(self.root / "workspace"), "SPEC_PORT": "4780",
            "SPEC_SSH_TARGET": "", "SPEC_SSH_KEY": "", "SPEC_SSH_WORKSPACE": "",
        }
        self.profile = {
            "provider": "openai", "model": "test-model", "endpoint": "https://example.test/v1",
            "apiKey": "test-only-profile-secret", "apiVersion": "",
        }
        self.voice = {
            "AZURE_OPENAI_REALTIME_ENDPOINT": "https://example.openai.azure.com",
            "AZURE_OPENAI_REALTIME_API_KEY": "test-only-voice-secret",
            "AZURE_OPENAI_REALTIME_DEPLOYMENT": "realtime",
        }


class MainTests(TemporarySetupTests):
    def setUp(self):
        super().setUp()
        self.ai = self.stack.enter_context(patch.object(setup, "collect_ai", return_value=(None, None)))
        self.dependencies = self.stack.enter_context(patch.object(setup, "dependencies", return_value=[]))
        self.launch = self.stack.enter_context(patch.object(setup, "launch"))
        self.progress = self.stack.enter_context(patch.object(
            setup, "progress", side_effect=lambda *a, **kw: contextlib.nullcontext()))
        self.process = self.stack.enter_context(patch.object(setup.subprocess, "call", return_value=0))
        self.stack.enter_context(patch.object(setup.subprocess, "run", side_effect=AssertionError("unexpected process")))
        self.stack.enter_context(patch.object(setup.subprocess, "Popen", side_effect=AssertionError("unexpected process")))

    def interview(self, answers, args=(), no_writes=False):
        with contextlib.ExitStack() as stack:
            if no_writes:
                for target in ("builtins.open", "os.open", "pathlib.Path.mkdir", "os.chmod"):
                    stack.enter_context(patch(target, side_effect=AssertionError("write forbidden")))
            prompt = stack.enter_context(patch("builtins.input", side_effect=answers))
            result = setup.main(["--no-animation", *args])
        self.assertEqual(prompt.call_count, len(answers), "unused interview answers")
        return result

    def test_default_interview_is_not_a_menu_and_does_not_save(self):
        self.assertEqual(self.interview([""] * 5, no_writes=True), 0)
        self.assertEqual(list(self.root.iterdir()), [])
        self.process.assert_not_called()
        self.ai.assert_called_once_with(setup.ask)
        self.dependencies.assert_called_once_with(remote=False)
        self.launch.assert_called_once_with(enabled=False)
        self.progress.assert_called_once_with("Checking local prerequisites", enabled=False)
        text = self.stdout.getvalue()
        self.assertIn("No menus", text)
        self.assertNotRegex(text, r"(?im)^\s*(?:\d+[.)]|select an option|choose an option)")
        for value in (str(self.root / "specs"), "SPEC_PORT: 4780", "Cancelled", "local editing"):
            self.assertIn(value, text)

    def test_dry_run_reviews_fixtures_without_writes_or_start_consent(self):
        self.ai.return_value = self.profile, self.voice
        self.assertEqual(self.interview([""] * 4, ["--dry-run"], no_writes=True), 0)
        self.process.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertIn("Dry run complete", self.stdout.getvalue())
        self.assertNotIn("May I save", self.stdout.getvalue())
        self.assertNotIn("May I download", self.stdout.getvalue())

    def test_summary_redacts_profile_and_voice_keys(self):
        self.ai.return_value = self.profile, self.voice
        self.assertEqual(self.interview([""] * 4, ["--dry-run"], no_writes=True), 0)
        text = self.stdout.getvalue() + self.stderr.getvalue()
        self.assertIn("key hidden", text)
        self.assertIn(self.profile["model"], text)
        self.assertNotIn(self.profile["apiKey"], text)
        self.assertNotIn(self.voice["AZURE_OPENAI_REALTIME_API_KEY"], text)

    def test_explicit_save_does_not_authorize_start(self):
        self.assertEqual(self.interview([""] * 4 + ["yes", ""]), 0)
        directory = self.root / ".spec-setup"
        self.assertEqual({p.name for p in directory.iterdir()}, {"start.sh", "requirements.txt"})
        self.assertEqual((directory / "requirements.txt").read_text(),
                         "Edit and save specs locally; configure optional services later.\n")
        self.assertFalse((self.root / "workspace").exists())
        self.assertFalse((self.root / "specs").exists())
        self.process.assert_not_called()
        self.assertIn("May I download build dependencies", self.stdout.getvalue())

    def test_defaults_keep_data_outside_group_writable_source_checkout(self):
        source = self.root / "source"
        source.mkdir(mode=0o775)
        source.chmod(0o775)
        with patch.object(setup, "ROOT", source):
            self.assertEqual(self.interview([""] * 4 + ["yes", "no"]), 0)
        self.assertTrue((self.root / ".spec-setup/start.sh").is_file())
        self.assertFalse((source / ".spec-setup").exists())
        script = (self.root / ".spec-setup/start.sh").read_text()
        self.assertIn(str(self.root / "specs"), script)
        self.assertIn(str(source / "run.sh"), script)

    def test_unsafe_default_workspace_suggests_private_alternative_without_chmod(self):
        workspace = self.root / "specs"
        workspace.mkdir()
        workspace.chmod(0o775)
        self.assertEqual(self.interview([""] * 4, ["--dry-run"], no_writes=True), 0)
        self.assertIn(str(self.root / "specs-private"), self.stdout.getvalue())
        self.assertEqual(stat.S_IMODE(workspace.stat().st_mode), 0o775)
        self.assertFalse((self.root / "specs-private").exists())

    def test_explicit_start_requires_separate_consent_and_propagates_failure(self):
        for status in (0, 23):
            with self.subTest(status=status):
                self.process.reset_mock()
                self.process.return_value = status
                directory = self.root / ("chosen setup " + str(status))
                self.assertEqual(self.interview([""] * 4 + ["yes", "yes"],
                                                ["--output-dir", str(directory)]), status)
                self.process.assert_called_once_with(["bash", str(directory / "start.sh")])
                self.assertTrue((directory / "start.sh").is_file())

    def test_missing_dependencies_allow_save_but_block_start(self):
        self.dependencies.return_value = ["rustc", "Linux"]
        self.ai.return_value = self.profile, self.voice
        self.assertEqual(self.interview([""] * 4 + ["yes"]), 0)
        self.assertTrue((self.root / ".spec-setup" / "profile.json").is_file())
        self.assertTrue((self.root / ".spec-setup" / "voice.env").is_file())
        self.process.assert_not_called()
        self.assertIn("Nothing started", self.stdout.getvalue())
        self.assertNotIn("May I download", self.stdout.getvalue())

    def test_unclear_save_and_start_answers_retry_without_authorization(self):
        self.assertEqual(self.interview([""] * 4 + ["maybe", "1", "yes", "perhaps", "2", "no"]), 0)
        self.assertEqual(self.stdout.getvalue().count("unclear answers never authorize"), 4)
        self.process.assert_not_called()

    def test_multiline_notes_are_saved_literally_not_executed(self):
        notes = ["  Keep leading and trailing spaces  ", "$(printf NOTES_EXECUTED); 'quoted' "]
        self.assertEqual(self.interview(notes + [""] * 4 + ["yes", "no"]), 0)
        self.assertEqual((self.root / ".spec-setup" / "requirements.txt").read_text(),
                         "\n".join(notes) + "\n")
        self.process.assert_not_called()

    def test_remote_invalid_inputs_retry_and_blank_key_uses_agent(self):
        bad_workspace = self.root / "file"
        bad_workspace.write_text("unchanged")
        answers = ["", str(bad_workspace), "", "0", "65536", "4781",
                   "ssh user@host", "user@example.test", str(self.root / "missing-key"), "",
                   "~/project", "/srv/project with spaces", "yes", "no"]
        self.assertEqual(self.interview(answers), 0)
        self.dependencies.assert_called_once_with(remote=True)
        script = (self.root / ".spec-setup" / "start.sh").read_text()
        self.assertIn("export SPEC_SSH_KEY=''", script)
        self.assertIn("export SPEC_SSH_TARGET=user@example.test", script)
        self.assertIn("export SPEC_PORT=4781", script)
        self.assertIn("export SPEC_SSH_WORKSPACE='/srv/project with spaces'", script)
        self.assertNotIn(" --local", script)
        self.assertEqual(bad_workspace.read_text(), "unchanged")

    def test_interrupt_and_eof_before_save_exit_130_without_writes(self):
        for error in (EOFError, KeyboardInterrupt):
            for prefix in ([], [""], [""] * 4):
                with self.subTest(error=error.__name__, prompt=len(prefix)):
                    self.assertEqual(self.interview(prefix + [error()], no_writes=True), 130)
                    self.assertEqual(list(self.root.iterdir()), [])
        self.process.assert_not_called()

    def test_interrupt_and_eof_after_save_keep_launcher_without_launch(self):
        for error in (EOFError, KeyboardInterrupt):
            with self.subTest(error=error.__name__):
                directory = self.root / error.__name__
                self.assertEqual(self.interview([""] * 4 + ["yes", error()],
                                                ["--output-dir", str(directory)]), 130)
                self.assertTrue((directory / "start.sh").is_file())
                self.assertIn(str(directory / "start.sh"), self.stderr.getvalue())
        self.process.assert_not_called()

    def test_interrupted_launch_returns_130_and_keeps_saved_setup(self):
        self.process.side_effect = KeyboardInterrupt
        self.assertEqual(self.interview([""] * 4 + ["yes", "yes"]), 130)
        self.assertTrue((self.root / ".spec-setup" / "start.sh").is_file())

    def test_ai_cancellation_and_errors_do_not_save(self):
        for error, status in ((EOFError(), 130), (KeyboardInterrupt(), 130),
                              (RuntimeError("test failure"), 1), (OSError("test I/O failure"), 1)):
            with self.subTest(error=type(error).__name__):
                self.ai.side_effect = error
                self.assertEqual(self.interview([""] * 4, no_writes=True), status)
                self.assertEqual(list(self.root.iterdir()), [])
        self.process.assert_not_called()
        self.dependencies.assert_not_called()

    def test_check_only_returns_dependency_status_without_interview(self):
        for missing in ([], ["Linux"]):
            with self.subTest(missing=missing):
                self.dependencies.return_value = missing
                self.assertEqual(self.interview([], ["--check"], no_writes=True), int(bool(missing)))
        self.launch.assert_not_called()
        self.ai.assert_not_called()
        self.process.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_existing_destination_aborts_before_ai_or_save(self):
        directory = self.root / ".spec-setup"
        directory.mkdir()
        sentinel = directory / "start.sh"
        sentinel.write_text("existing launcher")
        self.assertEqual(self.interview([""] * 4, no_writes=True), 1)
        self.assertEqual(sentinel.read_text(), "existing launcher")
        self.ai.assert_not_called()
        self.dependencies.assert_not_called()
        self.process.assert_not_called()


class ValidationTests(TemporarySetupTests):
    def test_blank_notes_default_and_multiline_preserves_whitespace(self):
        for answers, expected in [(["   "], "Edit and save specs locally; configure optional services later."),
                                  ([" first ", "second", ""], " first \nsecond")]:
            with self.subTest(answers=answers), patch("builtins.input", side_effect=answers):
                self.assertEqual(setup.requirements(), expected)

    def test_notes_reject_controls_and_enforce_utf8_byte_limit(self):
        with patch("builtins.input", side_effect=["bad\x1btext", "good", ""]):
            self.assertEqual(setup.requirements(), "good")
        for line in ("x" * 12000, "\u00e9" * 6000):
            with self.subTest(length=len(line)), patch("builtins.input", return_value=line):
                with self.assertRaisesRegex(ValueError, "12 KB"):
                    setup.requirements()
        with patch("builtins.input", side_effect=["x" * 11999, ""]):
            self.assertEqual(len(setup.requirements()), 11999)

    def test_ask_retries_controls_and_validation_errors(self):
        with patch("builtins.input", side_effect=["bad\x7f", "bad\u0080", "-1", " 004780 "]) as prompt:
            self.assertEqual(setup.ask("Port?", "4780", setup.port_number), "4780")
        self.assertEqual(prompt.call_count, 4)
        with patch("builtins.input", return_value=" "):
            self.assertEqual(setup.ask("Default?", "4780", setup.port_number), "4780")

    def test_consent_is_explicit(self):
        for value in ("YES!", "y", "yes please", "please do", "go ahead", "save", "start"):
            self.assertTrue(setup.consent(value))
        for value in ("NO.", "n", "no thanks", "not now", "later", "cancel"):
            self.assertFalse(setup.consent(value))
        for value in ("", "1", "maybe", "yes but don't start", "sure"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                setup.consent(value)

    def test_port_target_and_remote_path_validation(self):
        for value in ("1", "65535", "004780"):
            self.assertEqual(setup.port_number(value), str(int(value)))
        cases = [(setup.port_number, ["", "0", "65536", "-2", "+80", "1.0", "\u0661"]),
                 (setup.ssh_target, ["-oProxyCommand=bad", "ssh host", "host;id", "$(id)", "host\n"]),
                 (setup.remote_path, ["", "relative", "~/project", "/bad\npath", "/bad\x7fpath"]),
                 (setup.local_path, ["", "bad\x00path", "bad\u0080path"])]
        for validate, values in cases:
            for value in values:
                with self.subTest(validator=validate.__name__, value=value), self.assertRaises(ValueError):
                    validate(value)
        for value in ("local", "LOCAL ONLY!", "not now", "none"):
            self.assertEqual(setup.ssh_target(value), "")
        for value in ("build-alias", "user@example.test", "user@[::1]"):
            self.assertEqual(setup.ssh_target(value), value)

    def test_workspace_validation_never_changes_existing_permissions(self):
        directory = self.root / "existing"
        directory.mkdir(mode=0o700)
        for mode in (0o700, 0o755, 0o770, 0o777):
            with self.subTest(mode=oct(mode)):
                directory.chmod(mode)
                if mode & 0o022:
                    with self.assertRaises(ValueError):
                        setup.workspace_path(str(directory))
                else:
                    self.assertEqual(setup.workspace_path(str(directory)), directory)
                self.assertEqual(stat.S_IMODE(directory.stat().st_mode), mode)
        self.assertEqual(setup.workspace_path(str(self.root / "new")), self.root / "new")
        self.assertFalse((self.root / "new").exists())

    def test_workspace_rejects_build_and_public_assets_including_aliases(self):
        for relative in ("frontend", "frontend/dist", "frontend/dist/specs", "frontend/public/specs", "backend/target/specs"):
            with self.subTest(relative=relative), self.assertRaisesRegex(ValueError, "builds may publish or delete"):
                setup.workspace_path(str(self.root / relative))
        destination = self.root / "frontend/dist/specs"
        destination.mkdir(parents=True, mode=0o700)
        sentinel = destination / "existing.md"
        sentinel.write_text("keep these requirements")
        alias = self.root / "spec-alias"
        alias.symlink_to(destination, target_is_directory=True)
        with self.assertRaises(ValueError):
            setup.workspace_path(str(alias))
        self.assertEqual(sentinel.read_text(), "keep these requirements")

    def test_ssh_key_validates_path_without_reading_contents(self):
        key = self.root / "fake key"
        key.write_text("not a credential")
        with patch("builtins.open", side_effect=AssertionError("must not read keys")), \
                patch.object(Path, "read_text", side_effect=AssertionError("must not read keys")):
            self.assertEqual(setup.ssh_key(str(key)), str(key))
            for value in ("agent", "ssh agent", "ssh config", "default"):
                self.assertEqual(setup.ssh_key(value), "")
            for value in (str(self.root), str(self.root / "missing")):
                with self.assertRaises(ValueError):
                    setup.ssh_key(value)
            with patch.object(setup.os, "access", return_value=False), self.assertRaises(ValueError):
                setup.ssh_key(str(key))


class PersistenceTests(TemporarySetupTests):
    def test_setup_rejects_public_assets_and_build_output(self):
        for relative in ("frontend/public", "frontend/dist", "frontend/src/private", "backend/target/private"):
            destination = self.root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            with self.subTest(relative=relative), self.assertRaisesRegex(ValueError, "frontend assets"):
                setup.output_directory(destination, self.root / "workspace")
            self.assertFalse(destination.exists())

    def test_no_clobber_existing_directory_file_and_symlinks(self):
        victim = self.root / "victim"
        victim.write_text("keep me")
        directory = self.root / "existing"
        directory.mkdir(mode=0o750)
        directory.chmod(0o750)
        (directory / "start.sh").write_text("keep launcher")
        live = self.root / "live-link"
        live.symlink_to(directory, target_is_directory=True)
        dangling = self.root / "dangling-link"
        dangling.symlink_to(self.root / "absent", target_is_directory=True)
        for destination in (victim, directory, live, dangling):
            with self.subTest(destination=destination.name):
                with self.assertRaisesRegex(ValueError, "already exists"):
                    setup.output_directory(destination, self.root / "workspace")
                with self.assertRaises(FileExistsError):
                    setup.save_setup(destination, self.env, "notes", None, None)
        self.assertEqual(victim.read_text(), "keep me")
        self.assertEqual((directory / "start.sh").read_text(), "keep launcher")
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o750)
        self.assertTrue(live.is_symlink())
        self.assertTrue(dangling.is_symlink())
        self.assertFalse((self.root / "absent").exists())

    def test_creation_race_does_not_overwrite_new_destination(self):
        destination = setup.output_directory(self.root / "race", self.root / "workspace")
        destination.mkdir()
        sentinel = destination / "requirements.txt"
        sentinel.write_text("concurrent setup")
        with self.assertRaises(FileExistsError):
            setup.save_setup(destination, self.env, "replacement", None, None)
        self.assertEqual(sentinel.read_text(), "concurrent setup")
        self.assertFalse((destination / "start.sh").exists())

    def test_output_directory_rejects_public_and_untrusted_ancestors(self):
        workspace = self.root / "workspace"
        workspace.mkdir()
        static = self.root / "frontend" / "dist"
        static.mkdir(parents=True)
        unsafe = self.root / "shared"
        unsafe.mkdir()
        unsafe.chmod(0o777)
        alias = self.root / "alias"
        alias.symlink_to(workspace, target_is_directory=True)
        for destination in (workspace / "settings", static / "settings", unsafe / "settings",
                            alias / "settings", self.root / "missing" / "settings"):
            with self.subTest(destination=destination), self.assertRaises(ValueError):
                setup.output_directory(destination, workspace)
        good = self.root / "private-settings"
        self.assertEqual(setup.output_directory(good, workspace), good)
        self.assertFalse(good.exists())

    def test_saved_modes_and_contents_are_private_even_with_permissive_umask(self):
        directory = self.root / "saved"
        original = os.umask(0)
        try:
            launcher = setup.save_setup(directory, self.env, "line one\nline two", self.profile, self.voice)
        finally:
            os.umask(original)
        self.assertEqual(launcher, directory / "start.sh")
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        expected = {"start.sh": 0o700, "requirements.txt": 0o600,
                    "profile.json": 0o600, "voice.env": 0o600}
        self.assertEqual({p.name: stat.S_IMODE(p.stat().st_mode) for p in directory.iterdir()}, expected)
        self.assertEqual(json.loads((directory / "profile.json").read_text()), self.profile)
        self.assertEqual((directory / "requirements.txt").read_text(), "line one\nline two\n")
        self.assertNotIn("SPEC_SETTINGS_FILE", self.env, "save must not mutate caller configuration")
        self.assertNotIn("SPEC_AZURE_REALTIME_ENV_FILE", self.env)
        for secret in (self.profile["apiKey"], self.voice["AZURE_OPENAI_REALTIME_API_KEY"]):
            self.assertNotIn(secret, launcher.read_text())

    def test_voice_dotenv_serializes_dollars_quotes_and_backslashes(self):
        # Check the dotenv wire format directly; a shell source is not a dotenv parser.
        self.voice["AZURE_OPENAI_REALTIME_API_KEY"] = 'test$HOME${TOKEN}$(id)"quote\\path'
        directory = self.root / "voice"
        setup.save_setup(directory, self.env, "", None, self.voice)
        self.assertEqual((directory / "voice.env").read_text(),
                         'AZURE_OPENAI_REALTIME_ENDPOINT="https://example.openai.azure.com"\n'
                         'AZURE_OPENAI_REALTIME_API_KEY="test\\$HOME\\${TOKEN}\\$(id)\\"quote\\\\path"\n'
                         'AZURE_OPENAI_REALTIME_DEPLOYMENT="realtime"\n')

    def test_failed_file_write_leaves_no_launchable_entry_point(self):
        directory = self.root / "partial"
        real_open = os.open

        def fail_voice(path, flags, mode):
            if Path(path).name == "voice.env":
                raise OSError("simulated write failure")
            return real_open(path, flags, mode)

        with patch.object(setup.os, "open", side_effect=fail_voice):
            with self.assertRaises(OSError):
                setup.save_setup(directory, self.env, "notes", self.profile, self.voice)
        self.assertTrue(directory.is_dir())
        self.assertEqual(json.loads((directory / "profile.json").read_text()), self.profile)
        self.assertFalse((directory / "start.sh").exists())

    @unittest.skipUnless(shutil.which("bash"), "generated launchers require bash")
    def test_launcher_arguments_environment_and_shell_metacharacters_are_literal(self):
        # The stub reports through stdout, never writes records or invokes the real app.
        root = self.root / "checkout 'quoted' $(printf ROOT_INJECTION)"
        root.mkdir(mode=0o700)
        reporter = "import json,os,sys; print(json.dumps({'argv':sys.argv[1:],'env':dict(os.environ)}))"
        (root / "run.sh").write_text("#!/usr/bin/env bash\nexec " + shlex.quote(sys.executable)
                                     + " -I -B -c " + shlex.quote(reporter) + ' "$@"\n')
        self.env["SPEC_WORKSPACE"] = str(self.root / "work 'single' \"double\" $(printf WORK_INJECTION)")
        self.env["SPEC_SSH_WORKSPACE"] = "/srv/remote 'single' \"double\" $(printf REMOTE_INJECTION)"
        before = dict(self.env)
        with patch.object(setup, "ROOT", root):
            for name, target, key in (("local", "", ""), ("agent", "user@example.test", ""),
                                      ("key", "build-alias", str(self.root / "fake 'key' $(printf KEY_INJECTION)"))):
                with self.subTest(mode=name):
                    self.env.update(SPEC_SSH_TARGET=target, SPEC_SSH_KEY=key)
                    destination = self.root / (name + " 'saved' $(printf SAVE_INJECTION)")
                    launcher = setup.save_setup(destination, self.env, "notes", self.profile, self.voice)
                    child_env = {"PATH": os.defpath, "HOME": str(self.root), "LC_ALL": "C",
                                 "SPEC_COMMAND": "must-be-unset", "SPEC_SSH_BINARY": "must-be-unset",
                                 "SPEC_UI_DIR": "must-be-unset",
                                 **{k: "stale" for k in (*self.voice, *self.env)}}
                    result = subprocess.run([shutil.which("bash"), str(launcher)], cwd=self.root,
                                            env=child_env, capture_output=True, text=True, timeout=5, check=True)
                    self.assertEqual(result.stderr, "")
                    record = json.loads(result.stdout)
                    self.assertEqual(record["argv"], [] if target else ["--local"])
                    for variable, value in self.env.items():
                        self.assertEqual(record["env"][variable], value)
                    for variable in ("SPEC_COMMAND", "SPEC_SSH_BINARY", "SPEC_UI_DIR", *self.voice):
                        self.assertNotIn(variable, record["env"])
                    self.assertEqual(record["env"]["SPEC_SETTINGS_FILE"], str(destination / "profile.json"))
                    self.assertEqual(record["env"]["SPEC_AZURE_REALTIME_ENV_FILE"], str(destination / "voice.env"))
        self.assertEqual(self.env["SPEC_WORKSPACE"], before["SPEC_WORKSPACE"])
        self.assertFalse(Path(self.env["SPEC_WORKSPACE"]).exists())


class DependencyTests(TemporarySetupTests):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(setup.platform, "system", return_value="Linux"))
        self.stack.enter_context(patch.object(setup.sys, "version_info", (3, 9, 0)))
        self.which = self.stack.enter_context(patch.object(setup.shutil, "which", side_effect=lambda name: "/fake/" + name))
        self.versions = {"rustc": "rustc 1.98.0 (test)", "cargo": "cargo 1.98.0 (test)",
                         "bun": "1.3.14", "node": "v22.12.0"}
        self.run = self.stack.enter_context(patch.object(setup.subprocess, "run", side_effect=lambda argv, **kw:
            subprocess.CompletedProcess(argv, 0, self.versions[argv[0]], "")))
        self.stack.enter_context(patch.object(setup.subprocess, "call", side_effect=AssertionError("launch forbidden")))
        self.stack.enter_context(patch.object(setup.subprocess, "Popen", side_effect=AssertionError("process forbidden")))

    def test_baseline_versions_pass_with_read_only_timed_probes(self):
        self.assertEqual(setup.dependencies(), [])
        self.assertEqual(self.run.call_args_list, [
            call([command, "--version"], capture_output=True, text=True, timeout=5,
                 env={**os.environ, "RUSTUP_AUTO_INSTALL": "0"})
            for command in ("rustc", "cargo", "bun")])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_probes_disable_inherited_rustup_auto_install_without_changing_environment(self):
        with patch.dict(os.environ, {"RUSTUP_AUTO_INSTALL": "1", "RUSTUP_TOOLCHAIN": "missing-toolchain"}):
            self.assertEqual(setup.dependencies(), [])
            for probe in self.run.call_args_list:
                self.assertEqual(probe.kwargs["env"]["RUSTUP_AUTO_INSTALL"], "0")
                self.assertEqual(probe.kwargs["env"]["RUSTUP_TOOLCHAIN"], "missing-toolchain")
            self.assertEqual(os.environ["RUSTUP_AUTO_INSTALL"], "1")

    def test_old_malformed_and_new_versions(self):
        for command, label, bad, good in (
                ("rustc", "rustc 1.98+ (tested baseline)", "1.97.9", "1.100.0"),
                ("cargo", "cargo 1.98+ (tested baseline)", "1.97.9", "2.0.0"),
                ("bun", "Bun 1.3.14+ (tested baseline)", "1.3.13", "1.4.0")):
            original = self.versions[command]
            for version in (bad, "not a version", "1.98"):
                with self.subTest(command=command, version=version):
                    self.versions[command] = version
                    self.assertEqual(setup.dependencies(), [label])
            self.versions[command] = good
            self.assertEqual(setup.dependencies(), [])
            self.versions[command] = original

    def test_timeout_oserror_and_nonzero_exit_are_missing_dependencies(self):
        for response in (subprocess.TimeoutExpired("version", 5), OSError("unavailable"),
                         subprocess.CompletedProcess([], 1, "99.99.99", "failure"),
                         subprocess.CompletedProcess([], 0, "", "99.99.99")):
            with self.subTest(response=type(response).__name__):
                if isinstance(response, BaseException):
                    self.run.side_effect = response
                else:
                    self.run.side_effect = None
                    self.run.return_value = response
                missing = setup.dependencies()
                self.assertEqual(missing, ["rustc 1.98+ (tested baseline)", "cargo 1.98+ (tested baseline)",
                                           "Bun 1.3.14+ (tested baseline)"])

    def test_node_npm_fallback_only_when_bun_absent(self):
        self.which.side_effect = lambda name: None if name == "bun" else "/fake/" + name
        self.assertEqual(setup.dependencies(), [])
        self.assertEqual([c.args[0][0] for c in self.run.call_args_list], ["rustc", "cargo", "node"])
        self.assertIn("does not use frontend/bun.lock", self.stdout.getvalue())
        for version in ("v22.11.9", "unknown"):
            with self.subTest(node=version):
                self.versions["node"] = version
                self.assertEqual(setup.dependencies(), ["Node.js 22.12+ and npm (Bun fallback)"])
        self.versions["node"] = "v24.0.0"
        self.which.side_effect = lambda name: None if name in ("bun", "npm") else "/fake/" + name
        self.assertEqual(setup.dependencies(), ["Node.js 22.12+ and npm (Bun fallback)"])

    def test_installed_bun_takes_precedence_even_when_outdated(self):
        self.versions["bun"] = "1.3.13"
        self.assertEqual(setup.dependencies(), ["Bun 1.3.14+ (tested baseline)"])
        self.assertNotIn(call("node"), self.which.call_args_list)
        self.assertNotIn(call("npm"), self.which.call_args_list)
        self.assertNotIn("node", [c.args[0][0] for c in self.run.call_args_list])

    def test_platform_python_and_missing_tools_are_reported_without_probes(self):
        self.which.return_value = None
        self.which.side_effect = None
        for system in ("Darwin", "Windows"):
            with self.subTest(system=system), patch.object(setup.platform, "system", return_value=system), \
                    patch.object(setup.sys, "version_info", (3, 8, 20)):
                self.assertEqual(setup.dependencies(), [
                    "Linux", "Python 3.9+ for this wizard", "bash", "git", "cc", "stat", "mkdir", "realpath",
                    "rustc 1.98+ (tested baseline)", "cargo 1.98+ (tested baseline)",
                    "Node.js 22.12+ and npm (Bun fallback)"])
        self.run.assert_not_called()

    def test_remote_checks_local_ssh_only_never_connects(self):
        for exists, executable in ((False, False), (True, False), (True, True)):
            with self.subTest(exists=exists, executable=executable), \
                    patch.object(Path, "is_file", return_value=exists) as is_file, \
                    patch.object(setup.os, "access", return_value=executable) as access:
                self.assertEqual(setup.dependencies(remote=True),
                                 [] if exists and executable else ["OpenSSH client /usr/bin/ssh"])
                is_file.assert_called_once_with()
                if exists:
                    access.assert_called_once_with("/usr/bin/ssh", os.X_OK)
                else:
                    access.assert_not_called()
        self.assertIn("Remote prerequisites are NOT checked or installed", self.stdout.getvalue())
        self.assertTrue(all(c.args[0][1:] == ["--version"] for c in self.run.call_args_list))


if __name__ == "__main__":
    unittest.main()
