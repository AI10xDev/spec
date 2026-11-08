#!/usr/bin/env bash
# Run yourself in a private terminal. Secrets go directly to the remote hidden prompt.
set -euo pipefail
if [[ "$#" -gt 1 || ( "$#" -eq 1 && "$1" != --public-examples ) ]]; then
  printf 'Usage: configure_installed_sandbox.sh [--public-examples]\n' >&2
  exit 1
fi
if [[ ! -t 0 || ! -t 2 ]]; then
  printf 'Run this command in a private, interactive terminal; do not pipe credentials.\n' >&2
  exit 1
fi
key=/home/opencode/.local/share/paypal-sandbox-aue/admin_ed25519
hosts=/home/opencode/.local/share/paypal-sandbox-aue/known_hosts
test -f "$key" && test -f "$hosts"
printf 'Backend hostname to enter: paypal-skills-sandbox-5169fe7b.australiaeast.cloudapp.azure.com\n' >&2
remote='sudo -u spec-marketplace python3 -B /opt/spec-marketplace/scripts/setup_swa_marketplace.py'
if [[ "$#" -eq 1 ]]; then remote+=' --public-examples'; fi
ssh -t -i "$key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$hosts" \
  marketplaceadmin@paypal-skills-sandbox-5169fe7b.australiaeast.cloudapp.azure.com \
  "$remote"
printf 'Private setup completed. Services remain on standby; follow deploy/INSTALLED_AZURE_SANDBOX.md for activation.\n' >&2
