"""Optional AI interview, using only the Python 3.9+ standard library.

collect_ai only returns pending settings. The parent wizard must create new
private files, never overwrite existing ones, and write only after confirmation.
"""

import getpass
import ipaddress
import re
import warnings
from urllib.parse import urlsplit


# Keep defaults in sync with frontend/src/settings.tsx.
_DEFAULTS = {
    "azure": ("", "", "2024-10-21"),
    "openai": ("gpt-4.1-mini", "https://api.openai.com/v1", ""),
    "claude": ("claude-sonnet-4-5", "https://api.anthropic.com", ""),
    "openrouter": ("openai/gpt-4.1-mini", "https://openrouter.ai/api/v1", ""),
    "huggingface": ("", "http://127.0.0.1:8000/v1", ""),
}
_PATHS = {
    "azure": ("", "/openai/v1", "/openai/v1/responses"),
    "openai": ("", "/v1", "/v1/responses"),
    "claude": ("", "/v1", "/v1/messages"),
    "openrouter": ("", "/api/v1", "/api/v1/chat/completions"),
    "huggingface": ("", "/v1", "/v1/chat/completions"),
}


def _later(value):
    return value.strip().lower().rstrip(".! ") in {
        "", "later", "maybe later", "skip", "not now", "no thanks",
        "keep existing", "keep existing settings", "leave it for later",
    }


def _provider(value):
    if _later(value):
        return None
    # Match the entire affirmative phrase, not provider substrings in a denial,
    # question, comparison, or mixed request. Unrecognized prose is reprompted.
    text = value.strip().lower().rstrip(".! ")
    prefix = (
        r"(?:(?:i use|i'm using|i am using|i want to use|i'd like to use|"
        r"i would like to use|use|using|please use) )?(?:a |the )?"
    )
    aliases = {
        "azure": r"(?:microsoft )?azure(?: open\s?ai)?",
        "openai": r"(?:standalone )?open\s?ai",
        "claude": r"(?:anthropic(?:'s)?(?: claude)?|claude)",
        "openrouter": r"open\s?router",
        "huggingface": r"(?:local )?(?:hugging\s?face|hf)(?: model)?",
    }
    for provider, alias in aliases.items():
        if re.fullmatch(prefix + alias + r"(?: api)?(?:,? please)?", text):
            return provider
    raise ValueError(
        "Please name one provider clearly: OpenAI, Azure OpenAI, Claude, "
        "OpenRouter, or local Hugging Face; or say later to keep existing settings."
    )


def _model(value, provider, voice=False):
    deployment = provider == "azure" or voice
    limit = 128 if voice else 256
    pattern = r"[A-Za-z0-9_.-]+" if deployment else r"[A-Za-z0-9_.:/-]+"
    if (len(value) > limit or not re.fullmatch(pattern, value)
            or any(part in ("", ".", "..") for part in value.split("/"))):
        raise ValueError(
            "Enter a deployment name using ASCII letters, digits, hyphens, "
            "underscores or dots (maximum %s characters)." % limit
            if deployment else
            "Enter a model ID of at most 256 ASCII letters, digits, -_.:/; "
            "slash-separated parts cannot be empty, '.' or '..'."
        )
    return value


def _version(value, required=False):
    if (len(value) > 128 or not re.fullmatch(r"[A-Za-z0-9.-]*", value)
            or (required and not value)):
        raise ValueError(
            "Enter an API version using at most 128 ASCII letters, digits, "
            "hyphens or dots; a version is required for an Azure resource root."
        )
    return value


def _endpoint(value, provider):
    error = "Enter a valid provider root, API base, or completion URL."
    if (not value or len(value.encode("utf-8")) > 2048
            or any(c.isspace() or ord(c) < 32 or 127 <= ord(c) <= 159
                   or c == "\\" for c in value)):
        raise ValueError(error)
    try:
        url = urlsplit(value)
        host = url.hostname
        # Accessing port also checks malformed and out-of-range ports.
        url.port
        if not host or any(c in host for c in '%<>"^`{|}'):
            raise ValueError(error)
        if url.netloc.startswith("["):
            if not re.fullmatch(r"\[[0-9A-Fa-f:.]+\](?::[0-9]*)?", url.netloc):
                raise ValueError(error)
            ipaddress.IPv6Address(host)
        else:
            host.encode("idna")
    except (ValueError, UnicodeError):
        raise ValueError(error) from None
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host == "localhost"
    local = provider == "huggingface"
    if (url.username is not None or url.password is not None
            or "?" in value or "#" in value
            or not (url.scheme == "https" or (local and loopback and url.scheme == "http"))
            or (local and not loopback)):
        raise ValueError(
            "Cloud endpoints require HTTPS; local endpoints require localhost "
            "or a loopback address. No credentials, query or fragment are allowed."
        )
    if url.path.rstrip("/") not in _PATHS[provider]:
        raise ValueError(error)
    return value


def _voice_endpoint(value):
    if _later(value):
        return None
    # azure_realtime.rs requires the literal canonical origin, not just a URL
    # which normalizes to it (even an explicit :443 is rejected).
    match = re.fullmatch(r"https://([a-z0-9-]{1,63})\.openai\.azure\.com/?", value)
    if not match or match[1].startswith("-") or match[1].endswith("-"):
        raise ValueError(
            "Enter https://RESOURCE.openai.azure.com with an optional trailing /, "
            "without credentials, port, path, query or fragment; or say later."
        )
    return value


def _secret(label, optional=False):
    while True:
        try:
            # Raising at the warning prevents getpass's echoing input fallback.
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                value = getpass.getpass(label)
        except (getpass.GetPassWarning, EOFError, OSError):
            raise RuntimeError(
                "Cannot read a secret without echo. Run setup in a private terminal; "
                "no AI or voice settings have been saved."
            ) from None
        if (len(value) <= 4096 and (value or optional)
                and all(33 <= ord(c) <= 126 for c in value)):
            return value
        print("Use a nonempty ASCII key without whitespace (maximum 4096 characters)."
              if not optional else
              "Use an ASCII key without whitespace (maximum 4096 characters), or leave blank.")


def collect_ai(ask):
    """Return (Profile or None, voice environment dict or None), without I/O writes.

    ask(label, default='', validate=None) supplies free-text prompting, applies
    defaults, and retries ValueError. Secrets bypass ask and use getpass only.
    None means leave that existing configuration unchanged, not disable it.
    """
    print(
        "AI and voice setup are optional. Saying later leaves existing files untouched "
        "and inherits the launch environment/default settings. Previous wizard profiles "
        "are selected by their own saved launcher, not imported into a new setup.\n"
        "Setup proposes a new private plaintext profile and private voice settings, "
        "including keys; it must never overwrite existing files. They are saved "
        "only after the main wizard confirmation.\n"
        "Cloud completions can send unsaved text to the provider and incur costs. "
        "Voice can send audio and unsaved context and incur costs too. "
        "No external API calls are made during this interview.\n"
        "A local Hugging Face runtime is not installed or started here; bring a "
        "running OpenAI-compatible server. Loopback refers to each execution host, "
        "not your browser.\n"
        "Existing process exports may override Azure voice settings. OpenAI "
        "Realtime remains existing process configuration and is not set up here.",
        flush=True,
    )
    provider = ask(
        "Which AI provider would you like to use? Tell me in your own words, "
        "or say later to keep existing settings",
        default="later", validate=_provider,
    )
    profile = None
    if provider is not None:
        model_default, endpoint_default, version_default = _DEFAULTS[provider]
        model = ask(
            "What is your Azure deployment name?" if provider == "azure" else
            "Which model ID should Spec use? Defaults are examples; check availability",
            default=model_default, validate=lambda value: _model(value, provider),
        )
        endpoint = ask(
            "What trusted API endpoint should receive requests and your key?",
            default=endpoint_default, validate=lambda value: _endpoint(value, provider),
        )
        required = provider == "azure" and not urlsplit(endpoint).path.rstrip("/")
        version = ask(
            "Which API version? Required for this Azure root" if required else
            "Which API version, if any? Optional",
            default=version_default, validate=lambda value: _version(value, required),
        )
        key = _secret(
            "Local API key (hidden; blank if not needed): " if provider == "huggingface"
            else "Cloud API key (hidden; required): ",
            optional=provider == "huggingface",
        )
        profile = dict(provider=provider, model=model, endpoint=endpoint,
                       apiVersion=version, apiKey=key)

    voice = None
    endpoint = ask(
        "Would you like Azure voice independently of text AI? Enter your Azure "
        "resource origin, or say later to keep existing voice settings",
        default="later", validate=_voice_endpoint,
    )
    if endpoint is not None:
        deployment = ask(
            "What is your Azure Realtime deployment name?",
            validate=lambda value: _model(value, "azure", voice=True),
        )
        key = _secret("Azure voice API key (hidden; required): ")
        voice = {
            "AZURE_OPENAI_REALTIME_ENDPOINT": endpoint,
            "AZURE_OPENAI_REALTIME_DEPLOYMENT": deployment,
            "AZURE_OPENAI_REALTIME_API_KEY": key,
        }
    return profile, voice
