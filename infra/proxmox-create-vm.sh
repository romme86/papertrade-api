#!/usr/bin/env bash
# Creates the papertrade-api VM on the Geekom Proxmox host.
# Run as root ON THE PROXMOX HOST. Adapted from cassandrina's
# infrastructure/proxmox/proxmox-create-vms.sh (same Debian cloud image).

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root on the Proxmox host." >&2
  exit 1
fi

vmid="${VMID:-102}"
name="${VM_NAME:-papertrade-api}"
cores="${VM_CORES:-2}"
memory_mb="${VM_MEMORY_MB:-1024}"
# Balloon floor: lets Proxmox reclaim idle guest memory on the busy Geekom host.
balloon_mb="${VM_BALLOON_MB:-512}"
disk_size="${VM_DISK_SIZE:-20G}"
bridge="${PROXMOX_BRIDGE:-vmbr0}"
vm_storage="${PROXMOX_VM_STORAGE:-local-lvm}"
local_storage="${PROXMOX_LOCAL_STORAGE:-local}"
image_url="${DEBIAN_CLOUD_IMAGE_URL:-https://cloud.debian.org/images/cloud/trixie/latest/debian-13-generic-amd64.qcow2}"
image_path="${DEBIAN_CLOUD_IMAGE_PATH:-/var/lib/vz/template/iso/debian-13-generic-amd64.qcow2}"
ssh_public_key_file="${SSH_PUBLIC_KEY_FILE:-/root/cassandrina-vm-ssh.pub}"
vm_user="${VM_USER:-papertrade}"

if qm status "${vmid}" >/dev/null 2>&1; then
  echo "VMID ${vmid} already exists; pick another with VMID=..." >&2
  exit 2
fi
if [[ ! -f "${ssh_public_key_file}" ]]; then
  echo "Missing SSH public key file: ${ssh_public_key_file}" >&2
  exit 2
fi
# One authorized key per non-empty line of the key file.
ssh_keys_yaml="$(sed -e '/^[[:space:]]*$/d' -e 's/^/      - /' "${ssh_public_key_file}")"

pvesm set "${local_storage}" --content iso,vztmpl,backup,import,snippets
install -d -m 755 /var/lib/vz/template/iso /var/lib/vz/snippets
if [[ ! -f "${image_path}" ]]; then
  curl -fL --retry 3 --retry-delay 5 -o "${image_path}.tmp" "${image_url}"
  mv "${image_path}.tmp" "${image_path}"
fi

cat >"/var/lib/vz/snippets/${name}-user.yaml" <<EOF
#cloud-config
users:
  - default
  - name: ${vm_user}
    gecos: Papertrade API Operator
    groups: sudo
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    lock_passwd: true
    ssh_authorized_keys:
${ssh_keys_yaml}
package_update: true
packages: [ca-certificates, curl, git, gnupg, openssh-server, qemu-guest-agent, ufw]
runcmd:
  - systemctl enable --now qemu-guest-agent
  - systemctl enable --now ssh
final_message: "${name} cloud-init complete"
EOF

qm create "${vmid}" \
  --name "${name}" \
  --memory "${memory_mb}" \
  --balloon "${balloon_mb}" \
  --cores "${cores}" \
  --cpu host \
  --machine q35 \
  --ostype l26 \
  --agent enabled=1 \
  --scsihw virtio-scsi-single \
  --net0 "virtio,bridge=${bridge}" \
  --serial0 socket \
  --vga serial0 \
  --onboot 1
qm importdisk "${vmid}" "${image_path}" "${vm_storage}"
qm set "${vmid}" --scsi0 "${vm_storage}:vm-${vmid}-disk-0,discard=on,ssd=1"
qm set "${vmid}" --ide2 "${vm_storage}:cloudinit"
qm set "${vmid}" --boot order=scsi0
qm set "${vmid}" --ipconfig0 ip=dhcp
qm set "${vmid}" --cicustom "user=${local_storage}:snippets/${name}-user.yaml"
qm cloudinit update "${vmid}"
qm resize "${vmid}" scsi0 "${disk_size}"
qm start "${vmid}"

cat <<EOF
Created ${name} (VMID ${vmid}): ${cores} vCPU, ${memory_mb} MB (balloon min ${balloon_mb} MB), ${disk_size}.
Wait for cloud-init, then:
  qm agent ${vmid} ping
  qm guest cmd ${vmid} network-get-interfaces
Then copy infra/vm-bootstrap.sh to the VM and run it with sudo.
EOF
