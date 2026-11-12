{
  description = "LearnHarness VM — NixOS host for the deploy/ Docker stack (docs/self-hosting.md)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  # This deployment's hostnames, VPN endpoint, LAN gateway and root key
  # (site.nix). The default is the in-repo example, which is refused below;
  # rebuild.sh and tofu.sh override it with ~/.config/learnharness/site.
  inputs.site = {
    url = "path:./site.example";
    flake = false;
  };

  outputs = { self, nixpkgs, site }: {
    # deploy/nixos/rebuild.sh switch --target-host root@learnharness.fritz.box
    nixosConfigurations.learnharness =
      if builtins.readFile "${site}/site.nix" == builtins.readFile ./site.example/site.nix
      then throw "deploy/nixos: no site given, only the placeholder example. Build and deploy with deploy/nixos/rebuild.sh (site file: ~/.config/learnharness/site/site.nix, docs/self-hosting.md)."
      else nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [ ./configuration.nix ./learnharness-stack.nix ./wireguard.nix "${site}/site.nix" ];
      };

    # The bootstrap disk image OpenTofu uploads (deploy/proxmox). It is the
    # same system as above, so the VM is fully configured on first boot.
    packages.x86_64-linux.image = self.nixosConfigurations.learnharness.config.system.build.image;
  };
}
