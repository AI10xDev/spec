"""Offline sandbox bundle tests: synthetic inputs, temporary files, no deployment."""

import contextlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings

import setup_swa_marketplace as swa


HOST = "backend.example.test"
PASSWORD = "synthetic-password-'\"\\$HOME"
GITHUB_TOKEN = "synthetic-github-token"
CLIENT_ID = "synthetic-client-id"
CLIENT_SECRET = "synthetic-client-secret"
ANSWERS = [HOST, PASSWORD, GITHUB_TOKEN, CLIENT_ID, CLIENT_SECRET]


class BundleTests(unittest.TestCase):
    def test_public_examples_bundle_omits_github_token(self):
        files = swa.bundle(HOST, PASSWORD, "", CLIENT_ID, CLIENT_SECRET, public_examples=True)
        self.assertNotIn(b"SPEC_SKILLS_GITHUB_TOKEN", files["marketplace.env"])
        self.assertIn(b"SPEC_SKILLS_PUBLIC_EXAMPLES='1'", files["marketplace.env"])
        self.assertIn(b"SPEC_PAYPAL_MODE='sandbox'", files["marketplace.env"])
        with self.assertRaises(ValueError):
            swa.bundle(*ANSWERS, public_examples=True)

    def test_fixed_sandbox_configuration_uses_existing_serializer(self):
        expected = {
            "SPEC_SKILLS_GITHUB_TOKEN": GITHUB_TOKEN,
            "SPEC_SKILLS_GITHUB_REPO": "AI10x/skills-marketplace-examples",
            "SPEC_SKILLS_GITHUB_REF": "main",
            "SPEC_PAYPAL_CLIENT_ID": CLIENT_ID,
            "SPEC_PAYPAL_CLIENT_SECRET": CLIENT_SECRET,
            "SPEC_PAYPAL_MERCHANT_ID": "K2FXPYP83VR68",
            "SPEC_PAYPAL_RETURN_URL": "https://00z.ai/paypal/skills-marketplace",
            "SPEC_PAYPAL_MODE": "sandbox",
        }
        with patch.object(swa.setup, "serialize", wraps=swa.setup.serialize) as serialize:
            files = swa.bundle(*ANSWERS)
        serialize.assert_called_once_with(expected)
        self.assertEqual(files["marketplace.env"], swa.setup.serialize(expected))
        self.assertEqual(set(files), {"marketplace.env", "auth.token", "Caddyfile", "gateway-settings.json"})
        gateway = json.loads(files["gateway-settings.json"])
        self.assertEqual(gateway, {
            "PAYPAL_GATEWAY_PUBLIC_ORIGIN": "https://00z.ai",
            "PAYPAL_GATEWAY_UPSTREAM_ORIGIN": "https://" + HOST,
            "PAYPAL_GATEWAY_USERNAME": "patpal",
            "PAYPAL_GATEWAY_PASSWORD": PASSWORD,
            "PAYPAL_GATEWAY_WORKSPACE_TOKEN": files["auth.token"].decode().strip(),
        })
        for name, data in files.items():
            if name != "marketplace.env":
                for secret in (GITHUB_TOKEN, CLIENT_ID, CLIENT_SECRET):
                    self.assertNotIn(secret.encode(), data)
            if name != "gateway-settings.json":
                self.assertNotIn(PASSWORD.encode(), data)

    def test_generated_token_is_64_lower_hex_and_consistent(self):
        with patch.object(swa.secrets, "token_hex", wraps=swa.secrets.token_hex) as generate:
            files = swa.bundle(*ANSWERS)
        generate.assert_called_once_with(32)
        self.assertRegex(files["auth.token"], rb"\A[0-9a-f]{64}\n\Z")
        token = files["auth.token"].decode().strip()
        self.assertEqual(json.loads(files["gateway-settings.json"])["PAYPAL_GATEWAY_WORKSPACE_TOKEN"], token)
        self.assertIn(f'@unauthorized not header Authorization "Bearer {token}"', files["Caddyfile"].decode())
        self.assertEqual(files["Caddyfile"].decode().count(token), 1)

    def test_provider_punctuation_serialized_by_existing_helper(self):
        fixtures = ["'\"\\$HOME${HOME}`false`$(false);#=end\\", "".join(chr(c) for c in range(33, 127))]
        for fixture in fixtures:
            with self.subTest(fixture=fixture), \
                    patch.object(swa.setup, "serialize", wraps=swa.setup.serialize) as serialize:
                files = swa.bundle(HOST, PASSWORD, fixture, CLIENT_ID, fixture)
                config = serialize.call_args.args[0]
                self.assertEqual(config["SPEC_SKILLS_GITHUB_TOKEN"], fixture)
                self.assertEqual(config["SPEC_PAYPAL_CLIENT_SECRET"], fixture)
                self.assertEqual(files["marketplace.env"], swa.setup.serialize(config))
                self.assertEqual(json.loads(files["gateway-settings.json"])["PAYPAL_GATEWAY_PASSWORD"], PASSWORD)

    def test_hostname_and_caddy_injection_are_rejected_before_token_generation(self):
        invalid = (
            "", "localhost", "https://backend.example.test", "backend.example.test:443",
            "backend.example.test/path", "backend.example.test?x", "backend.example.test#x",
            "user@backend.example.test", "Backend.example.test", "*.example.test",
            "-bad.example.test", "bad-.example.test", "bad_name.example.test", "a..test",
            ".example.test", "example.test.", "a" * 64 + ".test", ".".join(["a" * 63] * 4),
            "example.test\nrespond 200", 'example.test" {', "example.test\r\n}",
            "example.test\tlog", "example.test\\x", "example.test\x00", "ex\u00e9mple.test",
        )
        for host in invalid:
            with self.subTest(host=host), patch.object(swa.secrets, "token_hex") as generate:
                with self.assertRaises(ValueError):
                    swa.bundle(host, *ANSWERS[1:])
                generate.assert_not_called()
        for host in ("a.test", "api-1.example.test", "a" * 63 + ".test"):
            self.assertIn((host + " {").encode(), swa.bundle(host, *ANSWERS[1:])["Caddyfile"])

    def test_password_and_provider_validation(self):
        for password in ("", "x" * 9, "x" * 513, "synthetic\npassword", "synthetic\tpassword", "synthetic\x7fpassword", "synthetic\u00e9password"):
            with self.subTest(password=password), self.assertRaises(ValueError):
                swa.bundle(HOST, password, *ANSWERS[2:])
        for password in ("x" * 10, "x" * 512, " spaces permitted "):
            files = swa.bundle(HOST, password, *ANSWERS[2:])
            self.assertEqual(json.loads(files["gateway-settings.json"])["PAYPAL_GATEWAY_PASSWORD"], password)
        for index in (2, 3, 4):
            for bad in ("", "synthetic\nINJECT=value", "synthetic secret", "x" * 4097):
                answers = ANSWERS.copy()
                answers[index] = bad
                with self.subTest(index=index, bad=bad), self.assertRaises(ValueError):
                    swa.bundle(*answers)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = self.root / "private"
        self.workspace, self.ui = self.root / "workspace", self.root / "ui"
        self.files = swa.bundle(*ANSWERS)

    def publish(self, directory=None):
        swa.publish(self.directory if directory is None else directory, self.files, self.workspace, self.ui)

    def test_private_regular_single_link_files_and_ready_published_last(self):
        write = swa.setup.write_private
        written = []

        def observe(path, data):
            self.assertFalse((self.directory / "ready").exists())
            if path.name == "ready":
                self.assertEqual(set(written), set(self.files))
                for name, expected in self.files.items():
                    self.assertEqual((self.directory / name).read_bytes(), expected)
            write(path, data)
            written.append(path.name)

        old_umask = os.umask(0)
        try:
            with patch.object(swa.setup, "write_private", side_effect=observe):
                self.publish()
        finally:
            os.umask(old_umask)
        self.assertEqual(written[-1], "ready")
        self.assertEqual(stat.S_IMODE(self.directory.lstat().st_mode), 0o700)
        expected_files = dict(self.files, ready=b"sandbox-v1\n")
        self.assertEqual({path.name for path in self.directory.iterdir()}, set(expected_files))
        for name, expected in expected_files.items():
            path = self.directory / name
            info = path.lstat()
            self.assertTrue(stat.S_ISREG(info.st_mode))
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
            self.assertEqual(info.st_nlink, 1)
            self.assertEqual(info.st_uid, os.geteuid())
            self.assertEqual(path.read_bytes(), expected)
        with self.assertRaises(ValueError):
            self.publish()
        for name, expected in expected_files.items():
            self.assertEqual((self.directory / name).read_bytes(), expected)

    def test_existing_destinations_and_symlinks_are_untouched(self):
        target = self.root / "target"
        target.mkdir(mode=0o700)
        sentinel = target / "sentinel"
        sentinel.write_bytes(b"synthetic-original")
        for kind in ("directory", "file", "symlink", "dangling"):
            path = self.root / kind
            if kind == "directory":
                path.mkdir(mode=0o755)
                path.chmod(0o755)
            elif kind == "file":
                path.write_bytes(b"synthetic-original")
            else:
                path.symlink_to(target if kind == "symlink" else self.root / "absent")
            before = path.lstat()
            with self.subTest(kind=kind), self.assertRaises((ValueError, OSError)):
                self.publish(path)
            self.assertEqual(path.lstat(), before)
            if kind == "file":
                self.assertEqual(path.read_bytes(), b"synthetic-original")
        self.assertEqual(sentinel.read_bytes(), b"synthetic-original")
        self.assertEqual(list(target.iterdir()), [sentinel])

    def test_symlink_ancestors_rejected_without_writes(self):
        real = self.root / "real"
        real.mkdir(mode=0o700)
        alias = self.root / "alias"
        alias.symlink_to(real, target_is_directory=True)
        for path in (alias / "private", alias / "missing" / "private"):
            with self.subTest(path=path), self.assertRaises((OSError, ValueError)):
                self.publish(path)
        self.assertEqual(list(real.iterdir()), [])

    def test_repository_workspace_ui_and_unsafe_paths_rejected_before_writes(self):
        paths = ["relative", self.root / ".." / "private", self.root / "bad\npath"]
        for public in (swa.setup.ROOT, self.workspace, self.ui):
            paths.extend((public, public / "private"))
        with patch.object(swa.setup, "write_private") as write:
            for path in paths:
                with self.subTest(path=path), self.assertRaises(ValueError):
                    self.publish(path)
            write.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_missing_or_publicly_writable_ancestors_rejected(self):
        unsafe = self.root / "unsafe"
        unsafe.mkdir()
        unsafe.chmod(0o777)
        for parent in (unsafe, self.root / "missing"):
            with self.subTest(parent=parent), self.assertRaises(ValueError):
                self.publish(parent / "private")
            self.assertFalse((parent / "private").exists())
        self.assertEqual(stat.S_IMODE(unsafe.stat().st_mode), 0o777)

    def test_partial_publication_failure_never_creates_ready(self):
        write = swa.setup.write_private
        for failed_name in (*self.files, "ready"):
            directory = self.root / ("failed-" + failed_name)
            attempted = []

            def fail(path, data):
                attempted.append(path.name)
                if path.name == failed_name:
                    raise OSError("synthetic-write-failure")
                write(path, data)

            with self.subTest(failed_name=failed_name), \
                    patch.object(swa.setup, "write_private", side_effect=fail), self.assertRaises(OSError):
                self.publish(directory)
            self.assertEqual(attempted[-1], failed_name)
            self.assertFalse((directory / "ready").exists())
            if directory.exists():
                self.assertEqual({p.name for p in directory.iterdir()}, set(attempted[:-1]))
                for name in attempted[:-1]:
                    self.assertEqual((directory / name).read_bytes(), self.files[name])

    def test_file_sync_failure_cleans_temporary_and_leaves_no_ready(self):
        with patch.object(swa.setup.os, "fsync", side_effect=[None, None, OSError("synthetic-sync-failure")]), \
                self.assertRaises(OSError):
            self.publish()
        first = next(iter(self.files))
        self.assertEqual({p.name for p in self.directory.iterdir()}, {first})
        self.assertEqual((self.directory / first).read_bytes(), self.files[first])
        self.assertFalse((self.directory / "ready").exists())


class MainTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = self.root / "private"
        self.args = ["--output", str(self.directory), "--workspace", str(self.root / "workspace"),
                     "--ui-dir", str(self.root / "ui")]
        self.stdout, self.stderr = io.StringIO(), io.StringIO()
        self.enterContext(contextlib.redirect_stdout(self.stdout))
        self.enterContext(contextlib.redirect_stderr(self.stderr))
        self.stdin_tty = self.enterContext(patch.object(sys.stdin, "isatty", return_value=True))
        self.stderr_tty = self.enterContext(patch.object(self.stderr, "isatty", return_value=True))
        self.enterContext(patch("builtins.input", side_effect=AssertionError("echoing input forbidden")))

    def assert_no_secrets(self, *extra):
        self.assertEqual(self.stdout.getvalue(), "")
        for secret in (*ANSWERS, *extra):
            self.assertNotIn(secret, self.stderr.getvalue())

    def test_public_examples_skip_token_prompt_and_require_distinct_confirmation(self):
        answers = [HOST, PASSWORD, CLIENT_ID, CLIENT_SECRET]
        with patch.object(swa.setup.getpass, "getpass", side_effect=answers + ["SAVE SANDBOX"]):
            self.assertEqual(swa.main(self.args + ["--public-examples"]), 1)
        self.assertFalse(self.directory.exists())
        with patch.object(swa.setup.getpass, "getpass", side_effect=answers + ["SAVE PUBLIC SANDBOX"]) as prompt:
            self.assertEqual(swa.main(self.args + ["--public-examples"]), 0)
        self.assertEqual(prompt.call_count, 5)
        self.assertTrue(all("GitHub token" not in call.args[0] for call in prompt.call_args_list))
        self.assertNotIn(b"SPEC_SKILLS_GITHUB_TOKEN", (self.directory / "marketplace.env").read_bytes())
        self.assertIn("anyone can read", self.stderr.getvalue())
        self.assert_no_secrets()

    def test_success_with_mocked_hidden_and_real_hidden_getpass(self):
        for prompt_owner, prompt_name in ((swa.setup, "hidden"), (swa.setup.getpass, "getpass")):
            self.directory = self.root / prompt_name
            args = ["--output", str(self.directory), *self.args[2:]]
            with self.subTest(prompt=prompt_name), \
                    patch.object(prompt_owner, prompt_name, side_effect=ANSWERS + ["SAVE SANDBOX"]) as prompt:
                self.assertEqual(swa.main(args), 0)
            self.assertEqual(prompt.call_count, 6)
            token = (self.directory / "auth.token").read_text().strip()
            gateway = json.loads((self.directory / "gateway-settings.json").read_bytes())
            self.assertEqual(gateway["PAYPAL_GATEWAY_PASSWORD"], PASSWORD)
            self.assertEqual(gateway["PAYPAL_GATEWAY_WORKSPACE_TOKEN"], token)
            self.assertIn(token, (self.directory / "Caddyfile").read_text())
            self.assertEqual((self.directory / "ready").read_bytes(), b"sandbox-v1\n")
            self.assert_no_secrets(token)

    def test_both_terminal_streams_required_before_prompt_or_write(self):
        for stdin, stderr in ((False, True), (True, False), (False, False)):
            self.stdin_tty.return_value, self.stderr_tty.return_value = stdin, stderr
            with self.subTest(stdin=stdin, stderr=stderr), patch.object(swa.setup, "hidden") as hidden, \
                    patch.object(swa, "publish") as publish:
                self.assertEqual(swa.main(self.args), 1)
            hidden.assert_not_called()
            publish.assert_not_called()
        self.assertFalse(self.directory.exists())
        self.assert_no_secrets()

    def test_echo_fallback_refused(self):
        def fallback(*args, **kwargs):
            warnings.warn("synthetic-echo-secret", swa.getpass.GetPassWarning)
            self.fail("echo fallback reached")

        with patch.object(swa.setup.getpass, "getpass", side_effect=fallback), patch.object(swa, "publish") as publish:
            self.assertEqual(swa.main(self.args), 1)
        publish.assert_not_called()
        self.assert_no_secrets("synthetic-echo-secret")

    def test_confirmation_is_exact_and_cancel_never_publishes(self):
        for confirmation in ("", "SAVE", "yes", "save sandbox", "SAVE SANDBOX ", " SAVE SANDBOX", "SAVE SANDBOX\n"):
            with self.subTest(confirmation=confirmation), \
                    patch.object(swa.setup.getpass, "getpass", side_effect=ANSWERS + [confirmation]), \
                    patch.object(swa, "publish") as publish:
                self.assertEqual(swa.main(self.args), 1)
            publish.assert_not_called()
        self.assertFalse(self.directory.exists())
        self.assert_no_secrets()

    def test_prompt_cancellation_and_errors_are_redacted(self):
        for error_type in (KeyboardInterrupt, EOFError, OSError, swa.getpass.GetPassWarning):
            for position in (0, 4, 5):
                with self.subTest(error=error_type, position=position), \
                        patch.object(swa.setup.getpass, "getpass", side_effect=ANSWERS[:position] + [error_type("synthetic-error-secret")]), \
                        patch.object(swa, "publish") as publish:
                    self.assertEqual(swa.main(self.args), 1)
                publish.assert_not_called()
        self.assertFalse(self.directory.exists())
        self.assert_no_secrets("synthetic-error-secret")

    def test_invalid_inputs_are_not_printed(self):
        for index, bad in ((0, "synthetic-host-secret\n}"), (1, "short"), (4, "synthetic secret\n")):
            answers = ANSWERS.copy()
            answers[index] = bad
            with self.subTest(index=index), patch.object(swa.setup.getpass, "getpass", side_effect=answers), \
                    patch.object(swa, "publish") as publish:
                self.assertEqual(swa.main(self.args), 1)
            publish.assert_not_called()
            self.assert_no_secrets(bad)

    def test_publication_error_is_redacted_and_partial_bundle_not_ready(self):
        with patch.object(swa.setup.getpass, "getpass", side_effect=ANSWERS + ["SAVE SANDBOX"]), \
                patch.object(swa.setup.os, "fsync", side_effect=[None, None, OSError("synthetic-filesystem-secret")]):
            self.assertEqual(swa.main(self.args), 1)
        self.assertTrue(self.directory.exists())
        self.assertFalse((self.directory / "ready").exists())
        self.assertIn("partial private bundle", self.stderr.getvalue())
        self.assert_no_secrets("synthetic-filesystem-secret")

    def test_secret_arguments_are_redacted(self):
        with patch.object(swa.setup, "hidden") as hidden, self.assertRaises(SystemExit) as exit_info:
            swa.main(self.args + ["--secret", "synthetic-argument-secret"])
        self.assertEqual(exit_info.exception.code, 2)
        hidden.assert_not_called()
        self.assert_no_secrets("synthetic-argument-secret")


class ServiceContractTests(unittest.TestCase):
    def test_service_paths_persistence_sandbox_and_least_privilege(self):
        root = Path(__file__).resolve().parent.parent
        backend = (root / "deploy/spec-marketplace.service").read_text()
        proxy = (root / "deploy/spec-marketplace-proxy.service").read_text()
        private = "/var/lib/spec-marketplace/private"
        self.assertEqual(swa.DEFAULT_STATE, Path("/var/lib/spec-marketplace"))
        self.assertEqual(swa.DEFAULT_UI, Path("/opt/spec-marketplace/ui"))
        for unit in (backend, proxy):
            lines = unit.splitlines()
            for directive in (f"ConditionPathExists={private}/ready", "User=spec-marketplace",
                              "Group=spec-marketplace", "UMask=0077", "NoNewPrivileges=true",
                              "ProtectSystem=strict", "ProtectHome=true", "PrivateTmp=true"):
                self.assertIn(directive, lines)
            self.assertFalse(any(line.startswith(("ExecStartPre=", "ExecStopPost=", "EnvironmentFile=")) for line in lines))
            self.assertNotIn("PAYPAL_GATEWAY_PASSWORD=", unit)
            self.assertNotIn("SPEC_PAYPAL_CLIENT_SECRET=", unit)
        for directive in (
            f"Environment=SPEC_AUTH_TOKEN_FILE={private}/auth.token",
            f"Environment=SPEC_AI_ENV_FILE={private}/marketplace.env",
            "Environment=SPEC_SETTINGS_FILE=/var/lib/spec-marketplace/receipts/profile.json",
            "Environment=SPEC_WORKSPACE=/var/lib/spec-marketplace/workspace",
            "Environment=SPEC_UI_DIR=/opt/spec-marketplace/ui",
            "Environment=SPEC_AZURE_REALTIME_ENV_FILE=/dev/null",
            "Environment=SPEC_PAYPAL_MODE=sandbox", "Environment=SPEC_PORT=4781",
            "ExecStart=/opt/spec-marketplace/spec", "CapabilityBoundingSet=",
        ):
            self.assertIn(directive, backend.splitlines())
        # Under ProtectSystem=strict only these exact paths may be writable.
        self.assertEqual([line for line in backend.splitlines() if line.startswith("ReadWritePaths=")],
                         ["ReadWritePaths=/var/lib/spec-marketplace/workspace /var/lib/spec-marketplace/receipts"])
        self.assertEqual([line for line in proxy.splitlines() if line.startswith("ReadWritePaths=")],
                         ["ReadWritePaths=/var/lib/spec-marketplace-tls"])
        for directive in ("Requires=spec-marketplace.service", "StateDirectory=spec-marketplace-tls",
                          "StateDirectoryMode=0700", "AmbientCapabilities=CAP_NET_BIND_SERVICE",
                          "CapabilityBoundingSet=CAP_NET_BIND_SERVICE",
                          f"ExecStart=/usr/bin/caddy run --config {private}/Caddyfile --adapter caddyfile"):
            self.assertIn(directive, proxy.splitlines())
        source = (root / "backend/src/main.rs").read_text()
        self.assertIn('std::env::var("SPEC_PORT")', source)
        self.assertIn("TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))", source)

    def test_caddy_guards_all_paths_without_logging_or_admin(self):
        files = swa.bundle(*ANSWERS)
        token = files["auth.token"].decode().strip()
        self.assertEqual(files["Caddyfile"].decode().split(), (
            "{ admin off } " + HOST + " { "
            '@unauthorized not header Authorization "Bearer ' + token + '" '
            'respond @unauthorized 401 header Cache-Control "private, no-store" '
            "reverse_proxy 127.0.0.1:4781 }"
        ).split())


if __name__ == "__main__":
    unittest.main()
