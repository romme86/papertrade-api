#!/usr/bin/env bash
# Allow only one LAN host (e.g. the cassandrina-app VM) to reach the published API
# port. Docker-published ports bypass ufw, so the rule goes in Docker's DOCKER-USER
# chain, matched on the ORIGINAL destination port (before Docker's DNAT).
#
#   sudo ALLOW_FROM=192.168.1.247 ./infra/lan-allowlist.sh install   # rule now + on every boot
#   sudo ./infra/lan-allowlist.sh apply                               # (re)apply from the saved config
#   sudo ./infra/lan-allowlist.sh remove

set -euo pipefail

conf=/etc/papertrade-api-allowlist.conf
unit=/etc/systemd/system/papertrade-api-allowlist.service
self=/usr/local/sbin/papertrade-api-allowlist

rule() {
  # shellcheck disable=SC1090
  . "${conf}"
  echo "-p tcp -m conntrack --ctorigdstport ${HOST_PORT} --ctdir ORIGINAL ! -s ${ALLOW_FROM} -j DROP"
}

apply() {
  local r
  r="$(rule)"
  # shellcheck disable=SC2086
  iptables -C DOCKER-USER ${r} 2>/dev/null || iptables -I DOCKER-USER ${r}
  echo "Only $(. "${conf}"; echo "${ALLOW_FROM}") may reach port $(. "${conf}"; echo "${HOST_PORT}")."
}

case "${1:-}" in
  install)
    [[ "${EUID}" -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
    : "${ALLOW_FROM:?Set ALLOW_FROM to the one LAN IP allowed to call the API}"
    printf 'ALLOW_FROM=%s\nHOST_PORT=%s\n' "${ALLOW_FROM}" "${HOST_PORT:-8787}" >"${conf}"
    install -m 0755 "$0" "${self}"
    cat >"${unit}" <<EOF
[Unit]
Description=Restrict the papertrade-api port to one LAN host
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${self} apply

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now papertrade-api-allowlist.service
    apply
    ;;
  apply)
    apply
    ;;
  remove)
    r="$(rule)"
    # shellcheck disable=SC2086
    while iptables -C DOCKER-USER ${r} 2>/dev/null; do iptables -D DOCKER-USER ${r}; done
    systemctl disable --now papertrade-api-allowlist.service 2>/dev/null || true
    rm -f "${unit}" "${conf}"
    ;;
  *)
    echo "usage: $0 install|apply|remove" >&2
    exit 1
    ;;
esac
