#!/usr/bin/env python3
"""Create a new private sandbox backend/gateway bundle; never deploy or print secrets."""

import getpass
import json
import os
from pathlib import Path
import re
import secrets
import signal
import sys

import setup_marketplace as setup

DEFAULT_STATE = Path("/var/lib/spec-marketplace")
DEFAULT_UI = Path("/opt/spec-marketplace/ui")


def bundle(host, password, github_token, client_id, client_secret, *, public_examples=False):
    if (len(host) > 253 or "." not in host or
            not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part)
                    for part in host.split("."))):
        raise ValueError("Use a lowercase public DNS hostname without scheme, port or path.")
    if not 10 <= len(password) <= 512 or not all(32 <= ord(c) <= 126 for c in password):
        raise ValueError("Gateway password must be 10-512 printable ASCII characters.")
    values = {
        "SPEC_SKILLS_GITHUB_TOKEN": github_token,
        "SPEC_SKILLS_GITHUB_REPO": "AI10x/skills-marketplace-examples",
        "SPEC_SKILLS_GITHUB_REF": "main",
        "SPEC_PAYPAL_CLIENT_ID": client_id,
        "SPEC_PAYPAL_CLIENT_SECRET": client_secret,
        "SPEC_PAYPAL_MERCHANT_ID": "K2FXPYP83VR68",
        "SPEC_PAYPAL_RETURN_URL": "https://00z.ai/paypal/skills-marketplace",
        "SPEC_PAYPAL_MODE": "sandbox",
    }
    if public_examples:
        if github_token:
            raise ValueError("Public example setup must not receive a GitHub token.")
        values.pop("SPEC_SKILLS_GITHUB_TOKEN")
        values["SPEC_SKILLS_PUBLIC_EXAMPLES"] = "1"
    provider = setup.serialize(values)
    token = secrets.token_hex(32)
    gateway = {
        "PAYPAL_GATEWAY_PUBLIC_ORIGIN": "https://00z.ai",
        "PAYPAL_GATEWAY_UPSTREAM_ORIGIN": "https://" + host,
        "PAYPAL_GATEWAY_USERNAME": "patpal",
        "PAYPAL_GATEWAY_PASSWORD": password,
        "PAYPAL_GATEWAY_WORKSPACE_TOKEN": token,
    }
    # Restrict every upstream path, not just Rust's authenticated API. No access
    # logging or administration endpoint; Caddy manages HTTPS certificates.
    caddy = f"""{{
    admin off
}}
{host} {{
    @unauthorized not header Authorization \"Bearer {token}\"
    respond @unauthorized 401
    header Cache-Control \"private, no-store\"
    reverse_proxy 127.0.0.1:4781
}}
"""
    return {
        "marketplace.env": provider,
        "auth.token": (token + "\n").encode("ascii"),
        "gateway-settings.json": (json.dumps(gateway, indent=2) + "\n").encode("ascii"),
        "Caddyfile": caddy.encode("ascii"),
    }


def publish(directory, files, workspace, ui):
    directory = Path(directory)
    setup.output_path(str(directory / "auth.token"), workspace, ui)
    # Refuse an existing bundle rather than rotating a token or replacing receipts.
    if os.path.lexists(directory):
        raise ValueError("Bundle directory already exists; nothing was overwritten.")
    for name, data in files.items():
        setup.write_private(directory / name, data)
    setup.write_private(directory / "ready", b"sandbox-v1\n")


def main(argv=None):
    parser = setup.Parser(description=__doc__)
    parser.add_argument("--output", default=str(DEFAULT_STATE / "private"))
    parser.add_argument("--workspace", default=str(DEFAULT_STATE / "workspace"))
    parser.add_argument("--ui-dir", default=str(DEFAULT_UI))
    parser.add_argument("--public-examples", action="store_true",
                        help="Opt in to anonymous reads of the public example repository in sandbox only")
    args = parser.parse_args(argv)
    try:
        if not sys.stdin.isatty() or not sys.stderr.isatty():
            raise ValueError("Use a private interactive terminal; piped secrets are refused.")
        print("Sandbox only. This prepares a new private bundle, not a deployment.\n"
              "Use rotated PayPal secrets. Private mode requires a repository-scoped GitHub token.\n"
              "No existing credentials are read; no network calls are made.", file=sys.stderr)
        if args.public_examples:
            print("PUBLIC EXAMPLES: anyone can read the skill files without paying.\n"
                  "No GitHub token is collected or sent. Restore repository privacy after testing.", file=sys.stderr)
        files = bundle(
            setup.hidden("Public HTTPS backend hostname (DNS must already point at this server)"),
            setup.hidden("New gateway password for patpal"),
            "" if args.public_examples else setup.hidden("GitHub token restricted to AI10x/skills-marketplace-examples"),
            setup.hidden("PayPal sandbox app client ID"),
            setup.hidden("PayPal sandbox app secret"),
            public_examples=args.public_examples,
        )
        confirmation = "SAVE PUBLIC SANDBOX" if args.public_examples else "SAVE SANDBOX"
        if setup.hidden("Type " + confirmation + " to publish the new private bundle") != confirmation:
            raise ValueError("Save not confirmed; nothing was written.")
        publish(args.output, files, args.workspace, args.ui_dir)
    except (EOFError, KeyboardInterrupt):
        print("Cancelled. Do not start services unless the bundle has a ready marker.", file=sys.stderr)
        return 1
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, getpass.GetPassWarning):
        print("Secure setup failed. A partial private bundle may remain; do not overwrite it or start services.", file=sys.stderr)
        return 1
    print("Private sandbox bundle saved. No secrets printed and no Azure settings changed.\n"
          "Follow deploy/README.md to validate TLS, start services and set the five gateway runtime settings.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    def cancel(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, cancel)
    raise SystemExit(main())
