# This deployment's site values: hostnames, the VPN endpoint, the LAN
# gateway and the root SSH key. The real file lives outside the repository,
# in ~/.config/learnharness/site/site.nix, and deploy/nixos/rebuild.sh passes
# it to the flake. This copy holds placeholders only: the flake refuses to
# build while any value below is still a placeholder. Start your own with
#
#   install -D -m 0644 deploy/nixos/site.example/site.nix ~/.config/learnharness/site/site.nix
#
# and replace every value (docs/self-hosting.md).
{
  services.learnharness = {
    # The app's public hostname (LH_HOST). Its A record points at the VM's
    # LAN address (deploy/proxmox/dns.tf).
    host = "learnharness.home.example.com";
    # Caddy site address for Keycloak (AUTH_SITE).
    authSite = "auth.home.example.com";
    # Keycloak's public URL (AUTH_URL, KC_HOSTNAME).
    authUrl = "https://auth.home.example.com";
  };

  services.learnharness.wireguard = {
    # The public name WireGuard clients connect to (written to server.json).
    endpoint = "vpn.example.com";
    # The A record the DDNS timer keeps on the WAN IPv4.
    ddnsName = "vpn.example.com";
    # The Cloudflare zone holding ddnsName.
    ddnsZone = "example.com";
    # The LAN router: the one LAN address the VM may query for DNS and NTP.
    lanGateway = "192.0.2.1";
  };

  # The SSH public key allowed to log in as root (nixos-rebuild, ssh).
  users.users.root.openssh.authorizedKeys.keys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyReplaceWithYourOwnPublicKey0000 you@example"
  ];
}
