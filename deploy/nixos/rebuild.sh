#!/usr/bin/env bash
# nixos-rebuild for the LearnHarness VM, with this deployment's site values
# wired in. Nothing to install: nixos-rebuild comes from the nixpkgs pinned
# in flake.lock.
#
#   deploy/nixos/rebuild.sh switch --target-host root@learnharness.fritz.box
#   deploy/nixos/rebuild.sh build
#
# Site values: ~/.config/learnharness/site/site.nix (never committed), a
# NixOS module with the hostnames, the WireGuard endpoint, DDNS name and
# zone, the LAN gateway and the root SSH key. Template:
# deploy/nixos/site.example/site.nix.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
site="${LEARNHARNESS_SITE:-$HOME/.config/learnharness/site}"
[ -f "$site/site.nix" ] || { echo "missing $site/site.nix (see docs/self-hosting.md)" >&2; exit 1; }
site="$(cd "$site" && pwd)"

exec nix run --inputs-from "$here" nixpkgs#nixos-rebuild -- "$@" \
  --flake "$here#learnharness" --override-input site "path:$site"
