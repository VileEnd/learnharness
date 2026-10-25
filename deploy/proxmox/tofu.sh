#!/usr/bin/env bash
# OpenTofu for the LearnHarness VM, with credentials and the NixOS image
# wired in. Nothing to install: OpenTofu and the image come from Nix.
#
#   deploy/proxmox/tofu.sh init
#   deploy/proxmox/tofu.sh plan
#   deploy/proxmox/tofu.sh apply
#
# Credentials: ~/.config/learnharness/proxmox.env (never committed) with
# PROXMOX_VE_ENDPOINT, PROXMOX_VE_API_TOKEN, PROXMOX_VE_INSECURE and
# TF_VAR_state_passphrase.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${LEARNHARNESS_PROXMOX_ENV:-$HOME/.config/learnharness/proxmox.env}"
[ -f "$env_file" ] || { echo "missing $env_file (see docs/self-hosting.md)" >&2; exit 1; }
# shellcheck source=/dev/null
source "$env_file"

# The bootstrap image (only uploaded when the VM is first created).
nix build "$here/../nixos#image" --out-link "$here/.image"
image="$(find -L "$here/.image" -maxdepth 1 -name '*.qcow2' | head -n1)"
[ -n "$image" ] || { echo "no qcow2 in $here/.image" >&2; exit 1; }
export TF_VAR_image_path="$image"

cd "$here"
exec nix run "github:NixOS/nixpkgs/nixos-26.05#opentofu" -- "$@"
