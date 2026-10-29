{
  description = "LearnHarness VM — NixOS host for the deploy/ Docker stack (docs/self-hosting.md)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }: {
    # nixos-rebuild switch --flake deploy/nixos#learnharness --target-host root@learnharness.fritz.box
    nixosConfigurations.learnharness = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [ ./configuration.nix ./learnharness-stack.nix ./wireguard.nix ];
    };

    # The bootstrap disk image OpenTofu uploads (deploy/proxmox). It is the
    # same system as above, so the VM is fully configured on first boot.
    packages.x86_64-linux.image = self.nixosConfigurations.learnharness.config.system.build.image;
  };
}
