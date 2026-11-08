# Installed Azure Sandbox

## Server

The separate Ubuntu 24.04 server is installed in `rg-paypal-sandbox-aue`:

- VM: `vm-paypal-sandbox`, Australia East, `Standard_B2ls_v2` (2 vCPU / 4 GiB).
- Disk: 64 GiB managed Standard SSD. Workspace, receipts and TLS state persist
  across restarts, but an off-VM backup policy is not configured yet.
- HTTPS: `https://paypal-skills-sandbox-5169fe7b.australiaeast.cloudapp.azure.com`.
- Public IP: `20.70.170.103`.
- Separate VNet/subnet/NSG, with no VNet peerings. Only TCP 80/443 are open to
  Internet clients. SSH is limited to the provisioning and development egress
  addresses recorded in `azure-sandbox.json`. Port 4781 is not public.
- Trusted Launch, Secure Boot and vTPM enabled. OS package updates installed.

The SSH host key was verified through Azure Run Command before the first SSH
connection. Local provisioning keys are outside the repository in the private
directory `/home/opencode/.local/share/paypal-sandbox-aue/`; do not publish them.
If connecting from another network, add only your trusted source IP to the NSG,
not `0.0.0.0/0`. Do not bypass SSH host-key checking.

## Installed State

The release backend and prefixed frontend are installed at `/opt/spec-marketplace`,
owned by root and read-only to the dedicated `spec-marketplace` account. Private
workspace and receipt directories exist under `/var/lib/spec-marketplace` with
mode 0700. Both real service units and the private setup helpers are installed.

The runtime artifact was built from `ddab9ce` plus only the marketplace, gateway
and persistent-auth changes. Unrelated feature-review and feedback-history edits
were excluded. Exact patches and source/runtime hashes are in the installed
`source-provenance.json`. `azure-sandbox.json` records the archive and binary hashes.
The installer, standby service, verifier and these installation notes are additional
deployment files, separate from that immutable runtime archive.

A subsequent frontend-only update adds **Enable editing** for unlocked skills.
It opens a new workspace copy (`skill-<id>.md`, with a numeric suffix for name
collisions), without changing the purchased original, GitHub file, or another
open/saved copy. Save and normal autosave after user edits persist that copy.
Opening it alone does not save, run a build, or make a payment. Reopen saved
copies from the workspace file list to continue editing them.

The update's exact source and asset hashes are recorded in
`/opt/spec-marketplace/skill-edit-update.json`. Assets were installed before an
atomic index switch, and old hashed assets were retained for open sessions.
77 browser tests and 216 unit tests passed on the isolated source. A live
read-only browser check verified the new index, authentication, content locking,
and editing UI using a browser-local paid-state fixture; no real entitlement or
server file was changed by that check. Refresh an existing page to load the update.

**The sandbox backend and authenticated HTTPS proxy are now active.** The private
provider bundle is installed, the five SWA gateway settings are configured, and
`spec-marketplace-standby.service` is disabled. The stock Caddy services remain
masked. Unauthenticated access is denied; the approved `patpal` login opens the
full workspace at `https://00z.ai/paypal/skills-marketplace`.

PayPal sandbox OAuth, real catalog previews, SDK eligibility, mobile layout,
content locking and backend restart continuity were verified. No order was
created or captured. The GitHub examples remain public. Secrets are not included
in this document; the approved credentials used during testing should be rotated.

## Enter Credentials Privately

The installed server is already configured. The following instructions are for
a future fresh setup, not a request to rerun the helper or overwrite the existing
bundle. Preserve its token and receipts; coordinate any planned credential rotation.

The example repository is temporarily public for testing. Anyone can read its
full skill files without purchasing; restore privacy before production use.
For this temporary test only, the installed helper supports `--public-examples`,
which skips the GitHub token prompt and enables anonymous reads only for the
exact example repository in sandbox mode. It requires typing `SAVE PUBLIC SANDBOX`.

Run the following in the **terminal on the existing development machine** where
`/home/opencode/spec` exists (for example, its SSH or VS Code Remote terminal),
not in the website, GitHub, chat, or an unrelated Azure Cloud Shell:

```sh
bash /home/opencode/spec/deploy/configure_installed_sandbox.sh --public-examples
```

If you are already connected by SSH to the **new backend VM** as
`marketplaceadmin`, use its installed helper directly instead:

```sh
sudo -u spec-marketplace python3 -B /opt/spec-marketplace/scripts/setup_swa_marketplace.py --public-examples
```

Both commands collect PayPal app credentials and a gateway password with typing
hidden. Do not supply a GitHub token for public-example mode. They still do not
activate services or change SWA settings. Public visibility does not expire
automatically, and copies made while public cannot be recalled.

For private-repository mode after testing, omit the option in a private,
unrecorded terminal on the shared development machine:

```sh
bash /home/opencode/spec/deploy/configure_installed_sandbox.sh
```

This opens a verified SSH connection and runs the existing hidden-input helper
as the service account. Enter the hostname above, a new gateway password, a
fine-grained GitHub token with **Contents: Read-only** for
`AI10x/skills-marketplace-examples`, and the PayPal sandbox client ID/secret.
The seller merchant ID, repository, return URL, username `patpal`, and sandbox
mode are preset. Rotate secrets previously placed in chat; do not paste new
secrets into chat, command arguments, Azure Run Command or logs.

The helper creates a new private bundle and refuses to overwrite an existing one.
It does not start services or update Nextweb. A failed setup can leave a partial
private directory: investigate it privately rather than deleting it blindly.

## Activate After Setup

On the backend server, validate the generated Caddy configuration with `caddy
validate`, never `caddy adapt` (which prints configuration including the token).
The service account must run the validation with its TLS storage environment:

```sh
sudo -u spec-marketplace env \
  XDG_DATA_HOME=/var/lib/spec-marketplace-tls \
  XDG_CONFIG_HOME=/var/lib/spec-marketplace-tls \
  caddy validate --config /var/lib/spec-marketplace/private/Caddyfile --adapter caddyfile
sudo systemctl enable --now spec-marketplace.service
sudo systemctl is-active spec-marketplace.service
```

Only if the backend is active, replace standby with the authenticated proxy:

```sh
sudo systemctl disable --now spec-marketplace-standby.service
sudo systemctl enable --now spec-marketplace-proxy.service
sudo systemctl is-active spec-marketplace-proxy.service
```

If the proxy fails, stop it and re-enable standby while investigating; never serve
an unguarded backend. Both proxies share the persisted TLS certificate storage.

Then add the five settings in the private `gateway-settings.json` through Azure's
protected SWA runtime settings UI, preserving existing settings. Target
`swa-nextweb-382de4d5` in **rg-opencode-aue**, not the new VM resource group.
Never upload the provider env file or replace the SWA's entire settings collection.
The exact backend origin is the HTTPS address above; credentials must match the
generated private bundle.

Check that unauthenticated access is denied, authenticate through
`https://00z.ai/paypal/skills-marketplace`, verify **sandbox** rather than demo/live
mode, then perform manual sandbox checkout using a separate personal buyer.
Restart the backend and verify pending orders and purchases remain recoverable.
The original installation used no provider credentials. Subsequent activation
verified sandbox OAuth and SDK eligibility with the approved app credentials, but
buyer approval, capture and purchase recovery still require manual acceptance.

## Verification And Costs

The installed binary passed loopback API authorization, static-asset, token
redaction and restart-stability checks as the service user. Caddy validation and
systemd unit verification passed. After OS updates and reboot, trusted HTTPS still
returned 503 with `private, no-store`; HTTP redirected to HTTPS. Isolated source
validation covered backend auth/marketplace tests, setup tests, frontend unit
tests and browser tests. These are not substitutes for real sandbox acceptance.

This VM, disk and public IP are billable resources. To stop compute charges when
not needed, explicitly deallocate the VM using Azure CLI; disks and public IP may
continue accruing charges. Do not delete this resource group once it contains
purchase receipts without a verified private backup and reconciliation plan.
