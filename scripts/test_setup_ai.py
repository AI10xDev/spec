"""Offline tests: no real prompts, secrets, network calls, or settings writes."""

import contextlib
import io
import os
import unittest
import warnings
from unittest.mock import Mock, patch

import setup_ai


class InterviewTests(unittest.TestCase):
    def setUp(self):
        self.output = io.StringIO()
        self.enterContext(contextlib.redirect_stdout(self.output))
        self.secret = self.enterContext(patch("setup_ai.getpass.getpass"))
        self.plain_input = self.enterContext(patch("builtins.input", side_effect=AssertionError("plain input")))
        self.enterContext(patch("builtins.open", side_effect=AssertionError("file I/O")))
        self.enterContext(patch("socket.socket", side_effect=AssertionError("network I/O")))

    # TestCase.enterContext was added in 3.11; keep these tests runnable on 3.9.
    def enterContext(self, manager):
        result = manager.__enter__()
        self.addCleanup(manager.__exit__, None, None, None)
        return result

    def interview(self, answers, secrets=()):
        answers = iter(answers)
        self.secret.side_effect = secrets
        self.errors = []

        def ask(label, default="", validate=None):
            while True:
                value = next(answers)
                value = default if value == "" else value
                try:
                    return validate(value) if validate else value
                except ValueError as error:
                    self.errors.append(str(error))

        self.ask = Mock(side_effect=ask)
        result = setup_ai.collect_ai(self.ask)
        self.assertEqual(list(answers), [], "unused prompt answers")
        return result

    def test_defaults_keep_both_settings_without_secrets(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "existing-text-secret",
                                    "AZURE_OPENAI_REALTIME_API_KEY": "existing-voice-secret"}):
            self.assertEqual(self.interview(["", ""]), (None, None))
        self.assertNotIn("existing-text-secret", self.output.getvalue())
        self.assertNotIn("existing-voice-secret", self.output.getvalue())
        self.secret.assert_not_called()
        self.assertEqual([call.kwargs["default"] for call in self.ask.call_args_list], ["later", "later"])
        for text in ("private plaintext", "never overwrite", "main wizard confirmation",
                     "unsaved text", "costs", "not installed", "process exports",
                     "OpenAI Realtime", "not set up here"):
            self.assertIn(text, self.output.getvalue())

    def test_all_providers_and_frontend_defaults(self):
        cases = [
            ("I use OpenAI", "openai", "", "", "", "gpt-4.1-mini", "https://api.openai.com/v1", ""),
            ("Azure OpenAI", "azure", "my-deploy", "https://example.openai.azure.com", "", "my-deploy", "https://example.openai.azure.com", "2024-10-21"),
            ("Claude", "claude", "", "", "", "claude-sonnet-4-5", "https://api.anthropic.com", ""),
            ("OpenRouter", "openrouter", "", "", "", "openai/gpt-4.1-mini", "https://openrouter.ai/api/v1", ""),
            ("a local Hugging Face model", "huggingface", "org/model", "", "", "org/model", "http://127.0.0.1:8000/v1", ""),
        ]
        for phrase, provider, model, endpoint, version, want_model, want_endpoint, want_version in cases:
            with self.subTest(provider=provider):
                key = "" if provider == "huggingface" else "test-only-key"
                keys = [key] if provider == "huggingface" else ["", key]
                profile, voice = self.interview([phrase, model, endpoint, version, "later"], keys)
                self.assertEqual(profile, dict(provider=provider, model=want_model,
                                              endpoint=want_endpoint, apiVersion=want_version, apiKey=key))
                self.assertIsNone(voice)
                self.assertEqual(self.errors, [])
                self.assertNotIn("test-only-key", self.output.getvalue())

    def test_prose_aliases(self):
        for phrase, provider in [
            ("I'd like to use Claude, please", "claude"),
            ("I'd like to use Claude please.", "claude"),
            ("I am using Microsoft Azure OpenAI", "azure"),
            ("Please use Anthropic", "claude"),
            ("using HF", "huggingface"),
            ("I want to use Open Router", "openrouter"),
            ("Standalone OpenAI", "openai"),
            ("HuggingFace", "huggingface"),
        ]:
            with self.subTest(phrase=phrase):
                self.assertEqual(setup_ai._provider(phrase), provider)

    def test_negative_ambiguous_requests_reprompt_without_secrets(self):
        bad = ["not OpenAI", "I don't use Claude", "OpenAI or Claude", "maybe OpenAI",
               "Azure OpenAI or OpenAI", "anything", "1", "OpenAI later", "no OpenRouter",
               "I used OpenAI before", "I never use OpenAI", "OpenAI?", "yes"]
        self.assertEqual(self.interview(bad + ["later", "later"]), (None, None))
        self.assertEqual(len(self.errors), len(bad))
        self.secret.assert_not_called()

    def test_invalid_fields_reprompt_and_secret_errors_are_redacted(self):
        profile, _ = self.interview(
            ["azure", "bad/model", "deploy", "http://bad.test", "https://resource.test",
             "bad version", "2024-10-21", "later"],
            ["", "secret with spaces", "secret\x00", "nonascii-\u00e9", "x" * 4097, "good-key"],
        )
        self.assertEqual(len(self.errors), 3)
        self.assertEqual(profile["apiKey"], "good-key")
        self.assertEqual(self.secret.call_count, 6)
        self.assertNotIn("secret with spaces", self.output.getvalue())
        self.assertNotIn("good-key", self.output.getvalue())

    def test_voice_independent_complete_and_exact_backend_names(self):
        profile, voice = self.interview(
            ["later", "https://my-resource.openai.azure.com/", "realtime-deploy"],
            ["voice-test-key"],
        )
        self.assertIsNone(profile)
        self.assertEqual(voice, {
            "AZURE_OPENAI_REALTIME_ENDPOINT": "https://my-resource.openai.azure.com/",
            "AZURE_OPENAI_REALTIME_DEPLOYMENT": "realtime-deploy",
            "AZURE_OPENAI_REALTIME_API_KEY": "voice-test-key",
        })

    def test_voice_reprompts_instead_of_returning_partial_settings(self):
        _, voice = self.interview(
            ["later", "https://wrong.test", "https://voice.openai.azure.com",
             "", "bad/name", "..", "realtime"], ["", "voice-key"],
        )
        self.assertEqual(len(self.errors), 4)
        self.assertEqual(len(voice), 3)
        self.assertEqual(voice["AZURE_OPENAI_REALTIME_API_KEY"], "voice-key")

    def test_text_and_voice_are_collected_together(self):
        profile, voice = self.interview(
            ["OpenAI", "", "", "", "https://voice.openai.azure.com", "realtime"],
            ["text-key", "voice-key"],
        )
        self.assertEqual(profile["apiKey"], "text-key")
        self.assertEqual(voice["AZURE_OPENAI_REALTIME_API_KEY"], "voice-key")

    def test_azure_version_required_only_at_resource_root(self):
        for path in ("", "/", "/openai/v1/", "/openai/v1/responses"):
            with self.subTest(path=path):
                self.interview(["Azure", "deployment", "https://azure.test" + path,
                                "", "later"], ["test-key"])
                validate = self.ask.call_args_list[3].kwargs["validate"]
                if path in ("", "/"):
                    with self.assertRaises(ValueError):
                        validate("")
                else:
                    self.assertEqual(validate(""), "")

    def test_key_bounds_and_local_optional_key(self):
        for optional in (False, True):
            with self.subTest(optional=optional):
                self.secret.side_effect = ["bad\tkey", "bad\x7f", "bad\u0080", "x" * 4097,
                                           "x" * 4096]
                self.assertEqual(setup_ai._secret("Hidden key: ", optional), "x" * 4096)
        self.secret.side_effect = [""]
        self.assertEqual(setup_ai._secret("Hidden key: ", optional=True), "")

    def test_getpass_warning_aborts_before_echo_fallback(self):
        def unsafe_read(label):
            self.assertIn("main wizard confirmation", self.output.getvalue())
            warnings.warn("cannot hide input", setup_ai.getpass.GetPassWarning)
            self.fail("echo fallback reached")

        for answers in (["OpenAI", "", "", ""],
                        ["later", "https://voice.openai.azure.com", "realtime"]):
            with self.subTest(answers=answers):
                with self.assertRaisesRegex(RuntimeError, "without echo"):
                    self.interview(answers, unsafe_read)
        self.plain_input.assert_not_called()

    def test_secret_read_failure_and_cancellation_never_return_partial(self):
        for error in (EOFError(), OSError(), KeyboardInterrupt()):
            with self.subTest(error=type(error).__name__):
                expected = KeyboardInterrupt if isinstance(error, KeyboardInterrupt) else RuntimeError
                with self.assertRaises(expected):
                    self.interview(["later", "https://voice.openai.azure.com", "whisper", "audio"], [error])


class ValidationTests(unittest.TestCase):
    def test_model_rules_and_bounds(self):
        for provider in setup_ai._DEFAULTS:
            for bad in ("", ".", "..", "a//b", "a/../b", "/a", "a/", "a b", "m\u00e9", "x" * 257):
                with self.subTest(provider=provider, value=bad):
                    with self.assertRaises(ValueError):
                        setup_ai._model(bad, provider)
            self.assertEqual(setup_ai._model("x" * 256, provider), "x" * 256)
        for bad in ("org/model", "model:tag"):
            with self.assertRaises(ValueError):
                setup_ai._model(bad, "azure")
            self.assertEqual(setup_ai._model(bad, "huggingface"), bad)
        with self.assertRaises(ValueError):
            setup_ai._model("x" * 129, "azure", voice=True)
        self.assertEqual(setup_ai._model("x" * 128, "azure", voice=True), "x" * 128)

    def test_api_versions(self):
        for bad in ("x" * 129, "2024_10_21", "a b", "a/b", "a?b", "\u00e9", "a\n"):
            with self.subTest(value=bad), self.assertRaises(ValueError):
                setup_ai._version(bad)
        self.assertEqual(setup_ai._version(""), "")
        self.assertEqual(setup_ai._version("2025-04-01-preview", True), "2025-04-01-preview")
        self.assertEqual(setup_ai._version("x" * 128), "x" * 128)
        with self.assertRaises(ValueError):
            setup_ai._version("", True)

    def test_endpoint_rules_for_every_provider(self):
        for provider, paths in setup_ai._PATHS.items():
            origin = "http://localhost:8000" if provider == "huggingface" else "https://provider.test"
            for path in paths:
                for suffix in ("", "/", "///"):
                    endpoint = origin + path + suffix
                    self.assertEqual(setup_ai._endpoint(endpoint, provider), endpoint)
            for bad in ("", "http://remote.test", "https://u:p@localhost", "https://localhost?",
                        "https://localhost#", "https://localhost/wrong", " https://localhost",
                        "https://localhost/\n", "https://localhost/\\v1", "https://local host",
                        "https://localhost:65536", "https://localhost:bad", "https://[::1",
                        "https://[::1]garbage", "https://%zz", "https://", "file:///v1",
                        "https://localhost/" + "x" * 2048):
                with self.subTest(provider=provider, endpoint=bad), self.assertRaises(ValueError):
                    setup_ai._endpoint(bad, provider)

    def test_local_loopback_only(self):
        for endpoint in ("http://127.0.0.2:8080/v1", "http://[::1]:8080/v1/chat/completions",
                         "https://localhost/v1/", "http://LOCALHOST:8000"):
            self.assertEqual(setup_ai._endpoint(endpoint, "huggingface"), endpoint)
        for endpoint in ("https://huggingface.co/v1", "http://localhost.evil.test/v1",
                         "http://192.168.1.3/v1", "https://[::ffff:127.0.0.1]/v1"):
            with self.assertRaises(ValueError):
                setup_ai._endpoint(endpoint, "huggingface")

    def test_voice_requires_canonical_azure_origin(self):
        for bad in ("http://a.openai.azure.com", "https://a.openai.azure.com:443",
                    "https://a.openai.azure.com:8443", "https://A.openai.azure.com",
                    "HTTPS://a.openai.azure.com", "https://a.openai.azure.com//",
                    "https://a.openai.azure.com/openai/v1", "https://a.openai.azure.com?",
                    "https://a.openai.azure.com#", "https://a.openai.azure.com.evil.test",
                    "https://user@a.openai.azure.com", "https://-a.openai.azure.com",
                    "https://a-.openai.azure.com", "https://a.b.openai.azure.com",
                    "https://a_b.openai.azure.com", "https://openai.azure.com",
                    "https://" + "a" * 64 + ".openai.azure.com"):
            with self.subTest(endpoint=bad), self.assertRaises(ValueError):
                setup_ai._voice_endpoint(bad)
        endpoint = "https://" + "a" * 63 + ".openai.azure.com/"
        self.assertEqual(setup_ai._voice_endpoint(endpoint), endpoint)
        self.assertIsNone(setup_ai._voice_endpoint("later"))


if __name__ == "__main__":
    unittest.main()
