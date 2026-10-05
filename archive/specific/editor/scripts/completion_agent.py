import os
import sys
import argparse
import json
from urllib import error, parse, request

DEFAULT_SYSTEM_PROMPT = (
    "You are an inline text completion assistant. Return only a short suffix that belongs immediately "
    "after the provided prefix. Complete the current word, add a brief phrase, or finish the current "
    "sentence. Never start a new line, continue with another sentence, repeat the prefix, use Markdown, "
    "or add commentary. Prefer the shortest natural completion and return only the characters to append."
)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--env-file",
        help="Path to a dotenv file containing Azure OpenAI configuration.",
    )
    parser.add_argument(
        "--system-prompt-file",
        help="Path to a file containing the full system prompt.",
    )
    parser.add_argument(
        "--system-prompt",
        help="System prompt for the completion model. Supports escaped newlines (\\n).",
    )
    return parser.parse_args()


def load_env_file(path):
    with open(path, "r", encoding="utf-8") as env_file:
        for line in env_file:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.removeprefix("export ").split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            os.environ.setdefault(key.strip(), value)


args = parse_args()
if args.env_file:
    load_env_file(args.env_file)

endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT")
deployment_name = os.environ.get("DEPLOYMENT_NAME", "gpt-5.5")

if args.system_prompt_file:
    with open(args.system_prompt_file, "r", encoding="utf-8") as f:
        system_prompt = f.read()
elif args.system_prompt:
    system_prompt = args.system_prompt.replace("\\n", "\n")
else:
    system_prompt = os.environ.get("SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT).replace("\\n", "\n")

def get_completion(context):
    try:
        api_key = os.environ.get("AZURE_OPENAI_API_KEY")
        api_version = os.environ.get("AZURE_OPENAI_API_VERSION")
        if not endpoint or not api_key:
            return "Error: AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY are required"

        is_responses_api = "/openai/v1" in endpoint
        if is_responses_api:
            url = endpoint.rstrip("/")
            if not url.endswith("/responses"):
                url += "/responses"
            payload = {
                "model": deployment_name,
                "instructions": system_prompt,
                "input": f"Prefix text:\n{context}\n\nReturn one short inline suffix only.",
            }
        else:
            if not api_version:
                return "Error: AZURE_OPENAI_API_VERSION is required for legacy Azure endpoints"
            url = (
                f"{endpoint.rstrip('/')}/openai/deployments/{parse.quote(deployment_name, safe='')}"
                f"/chat/completions?api-version={parse.quote(api_version, safe='')}"
            )
            payload = {
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": f"Prefix text:\n{context}\n\nReturn one short inline suffix only."},
                ]
            }

        api_request = request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"api-key": api_key, "Content-Type": "application/json"},
            method="POST",
        )
        with request.urlopen(api_request, timeout=60) as response:
            result = json.load(response)
        if is_responses_api:
            text = next(
                content["text"]
                for output in result["output"]
                for content in output.get("content", [])
                if content.get("type") == "output_text"
            )
        else:
            text = result["choices"][0]["message"]["content"]
        if not text:
            return ""

        # Clean up code blocks if the model wrapped the response in them
        if text.startswith("```"):
            lines = text.splitlines()
            if len(lines) >= 2:
                if lines[-1].startswith("```"):
                    text = "\n".join(lines[1:-1])
                else:
                    text = "\n".join(lines[1:])
        return text
    except error.HTTPError as e:
        details = e.read().decode("utf-8", errors="replace")
        return f"Error: Azure OpenAI returned HTTP {e.code}: {details}"
    except Exception as e:
        return f"Error: {e}"

# Simple protocol: read one line of context, output completion inside delimiters
for line in sys.stdin:
    if not line:
        continue
    # Decode double-escaped newlines and backslashes
    context = line.strip().replace("\\n", "\n").replace("\\\\", "\\")
    if context == "QUIT":
        break
    completion = get_completion(context)
    # Output completion, separated by a delimiter to handle multi-line returns
    print(f"COMPLETION_START\n{completion}\nCOMPLETION_END")
    sys.stdout.flush()
