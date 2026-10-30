# Private, per-invocation provider adapter. Stdout is captured, never logged.
set -eu
exec 3<&0
exec python3 - "$@" <<'PY'
import ipaddress
import json
import os
from pathlib import Path
import stat
import sys
import urllib.parse

try:
    path = Path(os.environ["SPEC_EXECUTION_PROFILE"])
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_size > 65536):
            raise ValueError()
        data = handle.read(65537)
        if len(data) > 65536:
            raise ValueError()
        profile = json.loads(data)
    provider, model, endpoint, version, key = (profile[name] for name in
        ("provider", "model", "endpoint", "apiVersion", "apiKey"))
    if (not all(isinstance(value, str) for value in (provider, model, endpoint, version, key))
            or provider not in ("azure", "openai", "claude", "openrouter", "huggingface")
            or not model or len(model) > 256 or any(c.isspace() or c in "#{}" for c in model)
            or not key.isascii() or any(c.isspace() or ord(c) < 32 for c in key)
            or (not key and provider != "huggingface")):
        raise ValueError()
    if sys.argv[1:2] == ["redact"]:
        patterns = sorted({value.encode() for value in (key, json.dumps(key)[1:-1]) if value}, key=len, reverse=True)
        pending = b""
        keep = max(map(len, patterns), default=1) - 1
        written = 0
        limit = None if sys.argv[2:] == ["optimize"] else 8388608
        while True:
            data = os.read(3, 65536)
            pending += data
            cut = max(0, len(pending) - keep) if data else len(pending)
            for secret in patterns:
                start = pending.find(secret)
                while 0 <= start < cut:
                    if start + len(secret) > cut:
                        cut = start
                        break
                    start = pending.find(secret, start + 1)
            safe, pending = pending[:cut], pending[cut:]
            for secret in patterns:
                safe = safe.replace(secret, b"[REDACTED]")
            if limit is not None:
                safe = safe[:max(0, limit - written)]
            sys.stdout.buffer.write(safe)
            sys.stdout.buffer.flush()
            written += len(safe)
            if not data:
                break
        sys.exit(0)
    defaults = {"openai": "https://api.openai.com/v1", "claude": "https://api.anthropic.com/v1",
                "openrouter": "https://openrouter.ai/api/v1"}
    endpoint = endpoint or defaults.get(provider, "")
    url = urllib.parse.urlsplit(endpoint)
    try:
        loopback = ipaddress.ip_address(url.hostname).is_loopback
    except (ValueError, TypeError):
        loopback = url.hostname == "localhost"
    if (not url.hostname or url.username or url.password or url.query or url.fragment
            or any(c.isspace() or c in "{}" for c in endpoint)
            or (provider == "huggingface" and not loopback)
            or not (url.scheme == "https" or (provider == "huggingface" and url.scheme == "http" and loopback))):
        raise ValueError()
    legacy_azure = provider == "azure" and not url.path.rstrip("/")
    protocol = "messages" if provider == "claude" else "chat" if provider in ("openrouter", "huggingface") or legacy_azure else "responses"
    suffix = {"messages": "/messages", "chat": "/chat/completions", "responses": "/responses"}[protocol]
    base = url.path.rstrip("/")
    if base.endswith(suffix):
        base = base[:-len(suffix)]
    if not base:
        base = ("/openai/deployments/" + urllib.parse.quote(model, safe="") if legacy_azure else
                "/api/v1" if provider == "openrouter" else "/v1")
    if provider == "azure" and not legacy_azure and not base.endswith("/openai/v1"):
        raise ValueError()
    base_url = urllib.parse.urlunsplit(url._replace(path=base))
    request_url = base_url + suffix
    headers = {"Content-Type": "application/json"}
    npm = "@ai-sdk/openai"
    options = {"baseURL": base_url, "apiKey": "{env:SPEC_EXECUTION_API_KEY}", "name": "spec-execution"}
    if provider == "azure":
        npm = "@ai-sdk/azure"
        options.update(apiVersion=version or "v1", useDeploymentBasedUrls=False)
        request_url += "?" + urllib.parse.urlencode({"api-version": version or "v1"})
        headers["api-key"] = key
        if legacy_azure:
            if not version:
                raise ValueError()
            npm = "@ai-sdk/openai-compatible"
            options = {"baseURL": base_url, "name": "spec-execution", "apiKey": "",
                       "headers": {"api-key": "{env:SPEC_EXECUTION_API_KEY}"},
                       "queryParams": {"api-version": version}}
    elif provider == "claude":
        npm = "@ai-sdk/anthropic"
        headers.update({"x-api-key": key, "anthropic-version": version or "2023-06-01"})
        options["headers"] = {"anthropic-version": version or "2023-06-01"}
    else:
        if provider in ("openrouter", "huggingface"):
            npm = "@ai-sdk/openai-compatible"
        if key:
            headers["Authorization"] = "Bearer " + key
    config = json.loads(os.environ.get("OPENCODE_CONFIG_CONTENT", "{}"))
    if not isinstance(config, dict):
        raise ValueError()
    provider_id = "spec-execution"
    selected_model = provider_id + "/" + model
    for section in ("provider", "agent", "mode"):
        if not isinstance(config.setdefault(section, {}), dict):
            raise ValueError()
    config["provider"][provider_id] = {"npm": npm, "name": "Selected execution provider", "options": options,
        "models": {model: {"id": model, "name": model, "tool_call": True}}}
    for section in ("agent", "mode"):
        build = config[section].setdefault("build", {})
        if not isinstance(build, dict):
            raise ValueError()
        build["model"] = selected_model
    config["model"] = selected_model
    config.setdefault("$schema", "https://opencode.ai/config.json")
    if "enabled_providers" in config:
        if not isinstance(config["enabled_providers"], list):
            raise ValueError()
        config["enabled_providers"] = list(dict.fromkeys(config["enabled_providers"] + [provider_id]))
    if provider_id in config.get("disabled_providers", []):
        raise ValueError()
    result = {"config": config, "url": request_url, "headers": headers, "model": model, "provider": provider,
              "protocol": protocol, "key": key}
    if sys.argv[1:] == ["config"]:
        result = config
    if sys.argv[1:] == ["key"]:
        sys.stdout.write(key or "local-no-key")
    elif sys.argv[1:] == ["model"]:
        sys.stdout.write(selected_model)
    else:
        sys.stdout.write(json.dumps(result))
except Exception:
    print("[remote] Invalid or unsupported selected execution provider configuration; refusing fallback.", file=sys.stderr)
    sys.exit(125)
PY
