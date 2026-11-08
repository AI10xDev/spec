#!/usr/bin/env python3
"""Provider-free acceptance of the installed binary under its service account."""

import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request


def main():
    if sys.argv[1:] not in ([], ["--public-examples"]):
        raise RuntimeError("Use --public-examples only for explicit anonymous GitHub catalog verification.")
    public_examples = sys.argv[1:] == ["--public-examples"]
    if os.geteuid() == 0:
        raise RuntimeError("Run as the unprivileged spec-marketplace service account.")
    install = Path("/opt/spec-marketplace")
    assert os.access(install / "spec", os.X_OK)
    assert not os.access(install / "spec", os.W_OK)
    assert not os.access(install / "ui", os.W_OK)
    assert "/paypal/skills-marketplace/assets/" in (install / "ui/index.html").read_text()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with tempfile.TemporaryDirectory(prefix="verify-", dir="/var/lib/spec-marketplace") as folder:
        root = Path(folder)
        token = "a1" * 32  # Only for this short-lived, loopback-only fixture.
        auth = root / "auth.token"
        auth.write_text(token + "\n")
        auth.chmod(0o600)
        for attempt in range(2):
            environment = {
                "HOME": str(root), "PATH": "/usr/bin:/bin",
                "SPEC_WORKSPACE": str(root / "workspace"),
                "SPEC_UI_DIR": str(install / "ui"),
                "SPEC_SETTINGS_FILE": str(root / "receipts/profile.json"),
                "SPEC_AUTH_TOKEN_FILE": str(auth),
                "SPEC_AI_ENV_FILE": "/dev/null", "SPEC_AZURE_REALTIME_ENV_FILE": "/dev/null",
                "SPEC_PORT": "0",
            }
            if public_examples:
                environment.update({
                    "SPEC_SKILLS_PUBLIC_EXAMPLES": "1",
                    "SPEC_SKILLS_GITHUB_REPO": "AI10x/skills-marketplace-examples",
                    "SPEC_SKILLS_GITHUB_REF": "main", "SPEC_PAYPAL_MODE": "sandbox",
                    "SPEC_PAYPAL_CLIENT_ID": "synthetic-client-id",
                    "SPEC_PAYPAL_CLIENT_SECRET": "synthetic-secret",
                    "SPEC_PAYPAL_MERCHANT_ID": "SYNTHETICMERCHANT",
                    "SPEC_PAYPAL_RETURN_URL": "https://example.test/",
                })
            process = subprocess.Popen([str(install / "spec")], cwd=root, env=environment,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    if not selector.select(15):
                        raise RuntimeError("Installed backend did not become ready.")
                    line = process.stdout.readline().strip()
                if not line.startswith("Spec: http://127.0.0.1:") or "#" in line:
                    raise RuntimeError("Unexpected backend startup response.")
                base = line.removeprefix("Spec: ")
                for credential, status in ((None, 401), ("wrong", 401), (token, 200)):
                    request = urllib.request.Request(base + "api/config")
                    if credential:
                        request.add_header("Authorization", "Bearer " + credential)
                    try:
                        response = opener.open(request, timeout=10)
                    except urllib.error.HTTPError as error:
                        response = error
                    with response:
                        assert response.code == status
                        assert response.headers.get("Cache-Control") == "no-store"
                        if status == 200:
                            settings = json.load(response)
                            assert not settings["execution"] and not settings["completion"]
                with opener.open(base, timeout=10) as response:
                    assert b"/paypal/skills-marketplace/assets/" in response.read()
                if public_examples and attempt == 0:
                    # Read-only catalog and entitlement checks. Never create/capture
                    # an order and never use real PayPal credentials in this fixture.
                    headers = {"Authorization": "Bearer " + token}
                    with opener.open(urllib.request.Request(base + "api/marketplace", headers=headers), timeout=30) as response:
                        catalog = json.load(response)
                    assert catalog["mode"] == "sandbox" and len(catalog["skills"]) == 5
                    assert all(not skill["purchased"] and "content" not in skill for skill in catalog["skills"])
                    path = "api/marketplace/skills/" + catalog["skills"][0]["id"] + "/content"
                    try:
                        with opener.open(urllib.request.Request(base + path, headers=headers), timeout=10):
                            raise AssertionError("Unpurchased content unexpectedly unlocked")
                    except urllib.error.HTTPError as error:
                        assert error.code == 403
            finally:
                process.terminate()
                try:
                    stdout, stderr = process.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    stdout, stderr = process.communicate(timeout=10)
                assert token not in stdout + stderr and "#token=" not in stdout + stderr
    print("PASS: installed binary, read-only assets, loopback authentication, restart-stable token and secret-free startup.")
    print("PASS: anonymous public GitHub catalog has five previews; unpurchased content remains locked. No PayPal calls." if public_examples
          else "No providers contacted.")


if __name__ == "__main__":
    main()
