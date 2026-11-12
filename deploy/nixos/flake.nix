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

  outputs = { self, nixpkgs, site }:
    let
      inherit (nixpkgs) lib;
      system = lib.nixosSystem {
        system = "x86_64-linux";
        modules = [ ./configuration.nix ./learnharness-stack.nix ./wireguard.nix "${site}/site.nix" ];
      };

      # Placeholder guard: checks the evaluated values, so a partly edited
      # copy of the example is refused as well as the example itself.
      inherit (system) config options;
      lh = config.services.learnharness;
      lhOpts = options.services.learnharness;
      wgOpts = lhOpts.wireguard;
      exampleKeyBodies = map (k: lib.elemAt (lib.splitString " " k) 1)
        (import ./site.example/site.nix).users.users.root.openssh.authorizedKeys.keys;
      rootKeys = config.users.users.root.openssh.authorizedKeys.keys;
      isExampleName = v: lib.hasSuffix "example.com" v;
      named = opt: placeholder: lib.optional placeholder (lib.showOption opt.loc);
      unset = opt: lib.optional (!opt.isDefined) "${lib.showOption opt.loc} (not set)";
      checkName = opt: if opt.isDefined then named opt (isExampleName opt.value) else unset opt;
      problems =
        map (n: named lhOpts.${n} (isExampleName lh.${n})) [ "host" "authSite" "authUrl" ]
        ++ map (n: named lhOpts.${n} (lh.tls == "cloudflare" && lh.${n} == lhOpts.${n}.default)) [ "host" "authSite" "authUrl" ]
        ++ lib.optionals lh.wireguard.enable (
          map (n: checkName wgOpts.${n}) [ "endpoint" "ddnsName" "ddnsZone" ]
          ++ [ (if wgOpts.lanGateway.isDefined
                then named wgOpts.lanGateway (lib.hasPrefix "192.0.2." lh.wireguard.lanGateway)
                else unset wgOpts.lanGateway) ]
        )
        ++ [ (lib.optional (rootKeys == [ ]) "users.users.root.openssh.authorizedKeys.keys (empty)") ]
        ++ [ (lib.optional (lib.any (k: lib.any (b: lib.hasInfix b k) exampleKeyBodies) rootKeys)
                "users.users.root.openssh.authorizedKeys.keys (the example key)") ];
      offending = lib.unique (lib.concatLists problems);
    in {
      # deploy/nixos/rebuild.sh switch --target-host root@learnharness.fritz.box
      nixosConfigurations.learnharness =
        if offending == [ ] then system
        else throw "deploy/nixos: the site still has placeholder values: ${lib.concatStringsSep ", " offending}. Build and deploy with deploy/nixos/rebuild.sh and a real site file (~/.config/learnharness/site/site.nix, docs/self-hosting.md).";

      # The bootstrap disk image OpenTofu uploads (deploy/proxmox). It is the
      # same system as above, so the VM is fully configured on first boot.
      packages.x86_64-linux.image = self.nixosConfigurations.learnharness.config.system.build.image;
    };
}
