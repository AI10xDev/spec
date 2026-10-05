"""Protocol tests without credentials or network access."""
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "filename_ranker", Path(__file__).resolve().parents[1] / "scripts/filename_ranker.py")
ranker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ranker)


class FilenameRanker(unittest.TestCase):
    def test_legacy_azure_request(self):
        with patch.dict(os.environ, {"AZURE_OPENAI_ENDPOINT": "https://example.invalid",
                                    "AZURE_OPENAI_API_KEY": "test-only",
                                    "AZURE_OPENAI_API_VERSION": "test-version"}, clear=True):
            req, responses = ranker.build_request("login settings", ["auth.ts", "config.ts"])
        self.assertFalse(responses)
        self.assertIn("/deployments/gpt-6-astra/chat/completions?api-version=test-version", req.full_url)
        payload = json.loads(req.data)
        self.assertEqual(json.loads(payload["messages"][1]["content"])["candidates"], ["auth.ts", "config.ts"])
        self.assertEqual(req.get_header("Api-key"), "test-only")

    def test_responses_endpoint_and_model_override(self):
        for suffix in ("/openai/v1", "/openai/v1/", "/openai/v1/responses"):
            with patch.dict(os.environ, {"AZURE_OPENAI_ENDPOINT": "https://example.invalid" + suffix,
                                        "AZURE_OPENAI_API_KEY": "test-only",
                                        "KIBI_FILENAME_MODEL": "my-astra-deployment"}, clear=True):
                req, responses = ranker.build_request("query", ["a.rs"])
            self.assertTrue(responses)
            self.assertEqual(req.full_url, "https://example.invalid/openai/v1/responses")
            self.assertEqual(json.loads(req.data)["model"], "my-astra-deployment")

    def test_both_response_formats(self):
        text = json.dumps({"indices": [1, 0]})
        chat = {"choices": [{"message": {"content": text}}]}
        responses = {"output": [{"content": [{"type": "output_text", "text": text}]}]}
        self.assertEqual(ranker.decode_response(json.dumps(chat), False, 2), {"indices": [1, 0]})
        self.assertEqual(ranker.decode_response(json.dumps(responses), True, 2), {"indices": [1, 0]})

    def test_invalid_or_invented_selections_are_rejected(self):
        for indices in ([2], [-1], [True], [0, 0], ["../secret"], None):
            raw = json.dumps({"choices": [{"message": {"content": json.dumps({"indices": indices})}}]})
            with self.assertRaises(ValueError):
                ranker.decode_response(raw, False, 2)
        with self.assertRaises(ValueError):
            ranker.decode_response(" " * (ranker.MAX_RESPONSE + 1), False, 2)

    def test_configuration_validation(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(ValueError):
            ranker.build_request("query", ["file"])
        with patch.dict(os.environ, {"AZURE_OPENAI_ENDPOINT": "http://example.invalid",
                                    "AZURE_OPENAI_API_KEY": "test-only"}, clear=True), self.assertRaises(ValueError):
            ranker.build_request("query", ["file"])


if __name__ == "__main__":
    unittest.main()
