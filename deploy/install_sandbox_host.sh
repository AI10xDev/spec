#!/usr/bin/env bash
# First installation on a dedicated Ubuntu host. No provider secrets are accepted.
set -euo pipefail
umask 077

if [[ "$EUID" -ne 0 || "$#" -ne 3 ]]; then
  printf 'Usage (root): install_sandbox_host.sh ARTIFACT SHA256 BACKEND_HOST\n' >&2
  exit 1
fi
artifact="$1"
checksum="$2"
hostname="$3"
if [[ ! "$checksum" =~ ^[a-f0-9]{64}$ || ! "$hostname" =~ ^[a-z0-9][a-z0-9.-]+[a-z0-9]$ ]]; then
  printf 'Invalid artifact checksum or hostname.\n' >&2
  exit 1
fi
if [[ -e /opt/spec-marketplace || -e /var/lib/spec-marketplace ]]; then
  printf 'Existing installation/state detected; refusing an overwrite.\n' >&2
  exit 1
fi
printf '%s  %s\n' "$checksum" "$artifact" | sha256sum --check --status
here="$(dirname -- "$(realpath -- "$0")")"
test -f "$here/spec-marketplace-standby.service"
test -f "$here/verify_sandbox_host.py"

# Do not let the distribution package briefly start a public default server.
systemctl mask caddy.service caddy-api.service
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y --no-install-recommends caddy ca-certificates python3 curl
adduser --system --group --home /var/lib/spec-marketplace --no-create-home --shell /usr/sbin/nologin spec-marketplace
install -d -o root -g root -m 0755 /opt/spec-marketplace /etc/spec-marketplace
install -d -o spec-marketplace -g spec-marketplace -m 0700 \
  /var/lib/spec-marketplace /var/lib/spec-marketplace/workspace /var/lib/spec-marketplace/receipts

# Only an already verified, non-secret runtime archive is extracted as root.
tar --extract --gzip --file "$artifact" --directory /opt --no-same-owner
chown -R root:root /opt/spec-marketplace
chmod -R u=rwX,go=rX /opt/spec-marketplace
chmod 0755 /opt/spec-marketplace/spec
install -m 0644 /opt/spec-marketplace/deploy/spec-marketplace.service /etc/systemd/system/
install -m 0644 /opt/spec-marketplace/deploy/spec-marketplace-proxy.service /etc/systemd/system/
install -m 0644 "$here/spec-marketplace-standby.service" /etc/systemd/system/
install -m 0644 "$here/verify_sandbox_host.py" /opt/spec-marketplace/scripts/
printf '{\n    admin off\n}\n%s {\n    header Cache-Control "private, no-store"\n    respond "Sandbox backend installed; awaiting private configuration." 503\n}\n' \
  "$hostname" > /etc/spec-marketplace/standby.Caddyfile
chmod 0644 /etc/spec-marketplace/standby.Caddyfile

systemctl daemon-reload
systemd-analyze verify spec-marketplace.service spec-marketplace-proxy.service spec-marketplace-standby.service
sudo -u spec-marketplace /usr/bin/caddy validate --config /etc/spec-marketplace/standby.Caddyfile --adapter caddyfile
sudo -u spec-marketplace python3 -B /opt/spec-marketplace/scripts/verify_sandbox_host.py
# The real backend/proxy stay disabled until private setup is explicitly completed.
systemctl enable --now spec-marketplace-standby.service
printf 'Installed. HTTPS standby denies access; sandbox credentials and activation are still required.\n'
