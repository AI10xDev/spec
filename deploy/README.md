# Sandbox Backend Deployment

This deploys the existing full app, not a separate payment implementation. It
requires a trusted Linux host with systemd, Caddy, persistent disk and an HTTPS
hostname. The service uses a dedicated account, keeps Rust on loopback, and
requires the server-held gateway bearer on every public upstream path. No live
payments, AI credentials or remote command execution are enabled by this setup.

## Current Target

The verified SWA is `swa-nextweb-382de4d5` in resource group `rg-opencode-aue`,
serving `00z.ai` from `AI10x/nextweb:main`. A separate backend VM is now installed
in `rg-paypal-sandbox-aue`, with an active authenticated HTTPS proxy and private
sandbox provider configuration. The SWA gateway is configured and verified; no
purchase or capture has been performed during activation.
See [Installed Azure Sandbox](INSTALLED_AZURE_SANDBOX.md) for its address, private
setup command, activation sequence, verification and costs. The generic
instructions below also apply when preparing another server.

Before activation, obtain a fine-grained GitHub token limited to **Contents:
read** for `AI10x/skills-marketplace-examples`. Do not reuse the GitHub CLI's
broader account token. Rotate the PayPal API secret and gateway password previously
shared in chat. The sandbox seller merchant ID is preset in the helper; the
business account login/password is not an API credential and is never collected.

Temporary public-example testing is also supported: use `--public-examples` with
the installed setup helper or connection wrapper. This skips the GitHub token
prompt, sets `SPEC_SKILLS_PUBLIC_EXAMPLES=1`, and permits only the exact example
repository with explicit sandbox mode. Anyone can read those public files without
paying. See the installed-server guide for the commands and how to restore private
mode; repository visibility does not revert automatically.

## Prepare The Host

Review the source/artifact being deployed. Do not package unrelated uncommitted
development changes by accident. Build this version with Rust and frontend build
tools in an isolated, reviewed checkout:

```sh
SPEC_PUBLIC_BASE_PATH=/paypal/skills-marketplace/ VITE_SPEC_GATEWAY_AUTH=1 ./build.sh
```

Install Caddy from your distribution's trusted package repository, but do not
enable its default public file server. Provision a dedicated system user/group
`spec-marketplace` with no login shell. Install the built `backend/target/release/spec`
as `/opt/spec-marketplace/spec`, and `frontend/dist/` as `/opt/spec-marketplace/ui/`.
The executable/UI must be owned by root and not writable by the service account.

Create `/var/lib/spec-marketplace` owned by `spec-marketplace` with mode 0700. Create its
`workspace` and `receipts` subdirectories owned by `spec-marketplace`, mode 0700.
Do not reuse your development workspace or existing unrelated receipt storage.
Preserve these directories for every later restart/update; never delete pending
orders or receipts to work around checkout failures.

Point a chosen DNS hostname at this host and permit only the intended HTTPS/ACME
ports 443/80 through its firewall. Keep Rust port 4781 private. Reusing the existing
VM avoids a new compute resource, but DNS, firewall changes and service installation
still require an operator's reviewed deployment action.

## Create Protected Configuration

Run in a private, unrecorded terminal as the service account. The parent directory
must already exist as described above. The script and its sibling
`setup_marketplace.py` must be readable from a root-owned installation directory:

```sh
sudo -u spec-marketplace python3 /opt/spec-marketplace/scripts/setup_swa_marketplace.py
```

The script prompts without echo for the backend hostname, a new gateway password,
the repository-scoped GitHub token and the sandbox PayPal client ID/secret. It
generates a random persistent workspace token and writes a new `private/` bundle
with 0700/0600 permissions, refusing existing destinations and symlinks:

- `marketplace.env`: sandbox provider configuration for Rust only.
- `auth.token`: 64 lowercase hex characters, stable across service restarts.
- `gateway-settings.json`: the five Nextweb runtime settings, including the same
  token. This file contains secrets; never serve, commit, print or attach it.
- `Caddyfile`: fixed HTTPS host, constant bearer check, and loopback proxy. It
  contains the token; never print it or run a config-adaptation command to stdout.
- `ready`: emitted last so incomplete setup cannot trigger these services.

There are no network calls, Azure updates or service starts in the helper. A
failure can leave an incomplete private directory; investigate privately rather
than retrying against it. Do not rotate tokens by rerunning the helper. Planned
rotation requires coordinated backend, proxy and SWA changes while preserving
receipts. Do not copy the provider env file to Nextweb.

## Start And Connect

Validate the generated Caddy configuration privately with `caddy validate` (do not
use `caddy adapt`, which prints the token). Install both `.service` files into
`/etc/systemd/system`, run `systemctl daemon-reload`, then enable/start
`spec-marketplace.service` and `spec-marketplace-proxy.service`. On hosts installed
with `install_sandbox_host.sh`, stop and disable `spec-marketplace-standby.service`
before starting the authenticated proxy so they do not compete for port 443. A ready marker is
necessary but not sufficient: verify both services are healthy and TLS is trusted.
Never add `--debug` or log request Authorization headers.

Using Azure's protected application-settings UI, add the five keys from the
private `gateway-settings.json` to the **production runtime settings** of the SWA
named above, preserving its existing settings. Do not put values in a CLI command,
build variables, workflow YAML, `NEXT_PUBLIC_*` or PR previews. This step requires
private operator access; the generated file is not a full replacement for all
Azure settings. The username defaults to `patpal`; configuration must use the
chosen new password and the exact same workspace token as Rust/Caddy.

AI is optional for checkout. Keep it disabled until the marketplace passes
sandbox acceptance. If later enabled, configure an explicitly approved provider
profile on this dedicated backend; do not scrape SSH/session credentials.

## Acceptance

Check unauthenticated access to both the public backend and the SWA document/API:
each must be denied. Authenticate at `https://00z.ai/paypal/skills-marketplace`;
confirm the five private-repository previews and **sandbox**, not demo/live, mode.
Full skill content must remain locked before capture. Use a separate sandbox
personal buyer for manual popup approval, cancellation and capture/reveal tests.

Restart the backend and confirm the gateway remains connected without changing
its token. Verify a pending order can still be checked, and a purchased skill can
still be revealed. Reconcile ambiguous payment errors; never assume a timeout
means no charge. Check TLS renewal, private backups, CSRF rejection and mobile
behavior. The services remain a single shared operator workspace, not per-buyer
accounts or licenses.

Offline checks from the checkout:

```sh
python3 -B -m unittest discover -s scripts -p 'test_setup_swa_marketplace.py' -v
cargo test --manifest-path backend/Cargo.toml --test auth
```
