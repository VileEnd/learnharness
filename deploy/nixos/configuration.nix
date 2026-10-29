{ modulesPath, pkgs, ... }:

{
  imports = [
    # A qcow2 disk image with legacy (BIOS) boot on /dev/vda; the root
    # filesystem grows to the Proxmox disk size on first boot.
    "${modulesPath}/virtualisation/disk-image.nix"
    "${modulesPath}/profiles/qemu-guest.nix"
  ];

  image.format = "qcow2";
  image.efiSupport = false;
  image.baseName = "learnharness-nixos";

  networking.hostName = "learnharness";
  # DHCP from the FRITZ!Box (later the UniFi gateway). The hostname rides
  # the DHCP request, so the router serves learnharness.fritz.box.
  networking.useDHCP = true;
  networking.firewall.allowedTCPPorts = [ 22 80 443 8443 ];

  time.timeZone = "Europe/Berlin";
  i18n.defaultLocale = "en_US.UTF-8";

  services.qemuGuest.enable = true;

  # Public names with publicly trusted certificates (Let's Encrypt via the
  # Cloudflare DNS challenge); the A records point at the LAN address
  # (deploy/proxmox/dns.tf). Nothing is reachable from the internet.
  services.learnharness = {
    host = "learnharness.home.moyjak.com";
    authSite = "auth.home.moyjak.com";
    authUrl = "https://auth.home.moyjak.com";
    tls = "cloudflare";
  };

  # Remote access from outside: WireGuard on this VM, devices from Settings →
  # Users, endpoint vpn.moyjak.com:51820 (DDNS). docs/self-hosting.md.
  services.learnharness.wireguard.enable = true;

  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "prohibit-password";
    };
  };
  users.users.root.openssh.authorizedKeys.keys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBiDNkqEwOkoseC8Aqw8PirEL4NsNYMT9xOW7HskpscG vileend"
  ];

  # The image build (npm ci + next build) and Keycloak share 4 GB of RAM.
  zramSwap.enable = true;

  nix.settings = {
    experimental-features = [ "nix-command" "flakes" ];
    trusted-users = [ "root" ];
  };
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 30d";
  };

  environment.systemPackages = with pkgs; [ git htop curl ];
  documentation.enable = false;

  system.stateVersion = "26.05";
}
