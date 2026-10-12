#!/usr/bin/env bash
# One-time setup of the papertrade-api VM. Run with sudo ON THE VM.

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script with sudo on the papertrade-api VM." >&2
  exit 1
fi

vm_user="${VM_USER:-papertrade}"
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git gnupg openssh-server qemu-guest-agent ufw

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/debian/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
usermod -aG docker "${vm_user}"
systemctl enable --now docker qemu-guest-agent

# WITH_TAILSCALE=false when the API is reached over the home LAN instead
# (then restrict the port with ./infra/lan-allowlist.sh).
if [[ "${WITH_TAILSCALE:-true}" == "true" ]]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
  systemctl enable --now tailscaled
fi

# Only SSH is opened in ufw. The API is published by Docker on BIND_ADDRESS
# only (the Tailscale IP, or the LAN IP plus lan-allowlist.sh), because Docker
# bypasses ufw.
ufw allow OpenSSH
ufw --force enable

cat <<EOF
Bootstrap complete. Next, as ${vm_user}:
  1. Tailscale: sudo tailscale up --hostname=papertrade-api
     LAN instead: BIND_ADDRESS=<this VM's LAN IP> in step 5, then
     sudo ALLOW_FROM=<caller's LAN IP> ./infra/lan-allowlist.sh install
  2. git clone https://github.com/romme86/papertrade-api.git ~/papertrade-api
  3. cd ~/papertrade-api && cp .env.example .env && chmod 600 .env
  4. docker compose --env-file ~/papertrade-api/.env build
  5. docker compose --env-file ~/papertrade-api/.env run --rm papertrade-api node dist/keygen.js
     -> paste WALLET_PRIVATE_KEY and API_TOKEN into .env, set BIND_ADDRESS to \$(tailscale ip -4) or the LAN IP
  6. docker compose --env-file ~/papertrade-api/.env up -d
EOF
