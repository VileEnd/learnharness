{ config, lib, pkgs, ... }:

# Remote access: WireGuard ends on this VM (docs/self-hosting.md, "Remote
# access (WireGuard)"). Peers are created in the app (Settings → Users) and
# reach the host only as peers.json in the shared data volume; wg-apply.py
# validates and applies them. A peer can reach Caddy (80/443) and nothing else:
# not SSH, not the LAN. Independently, the VM and its containers may not open
# connections into the LAN (replies to LAN clients and the gateway's DNS/NTP
# excepted), so access from home (22/80/443/8443) is unchanged.
let
  cfg = config.services.learnharness.wireguard;
  stateDir = "/var/lib/learnharness";
  wgDir = "${stateDir}/volumes/learnharness/data/global/wireguard";
  keyFile = "${stateDir}/wg/private";
  port = toString cfg.port;
  gw = cfg.lanGateway;

  applier = lib.escapeShellArgs [
    "${pkgs.python3}/bin/python3" "-I" "-B" "${./wg-apply.py}"
    "--dir" wgDir
    "--private-key" keyFile
    "--interface" "wg0"
    "--listen-port" port
    "--endpoint" "${cfg.endpoint}:${port}"
  ];

  ddns = pkgs.writeShellApplication {
    name = "learnharness-ddns";
    runtimeInputs = with pkgs; [ curl jq coreutils ];
    text = ''
      # Keeps the A record $DDNS_NAME on the WAN IPv4. Never prints the token.
      if [ -z "''${CLOUDFLARE_API_TOKEN:-}" ]; then
        echo "ddns: no CLOUDFLARE_API_TOKEN in ${stateDir}/secrets.env; skipping"
        exit 0
      fi
      # The token goes to curl in a header file, never in argv.
      hdr=$(mktemp)
      trap 'rm -f "$hdr"' EXIT
      printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$CLOUDFLARE_API_TOKEN" >"$hdr"
      unset CLOUDFLARE_API_TOKEN

      ip=$(curl -4 -s --max-time 15 https://api.ipify.org || true)
      valid=false
      if [[ $ip =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; then
        valid=true
        for o in "''${BASH_REMATCH[@]:1}"; do
          if [ "$o" -gt 255 ]; then valid=false; fi
        done
      fi
      if [ "$valid" != true ]; then
        echo "ddns: api.ipify.org returned no IPv4 address" >&2
        exit 1
      fi

      api=https://api.cloudflare.com/client/v4
      cf() {
        local out
        out=$(curl -sS --max-time 20 -H @"$hdr" "$@")
        if ! jq -e '.success == true' >/dev/null 2>&1 <<<"$out"; then
          echo "ddns: Cloudflare API error: $(jq -c '.errors // "no JSON"' 2>/dev/null <<<"$out")" >&2
          return 1
        fi
        printf '%s' "$out"
      }

      zones=$(cf -G "$api/zones" --data-urlencode "name=$DDNS_ZONE")
      zid=$(jq -r '.result[0].id // empty' <<<"$zones")
      if [ -z "$zid" ]; then
        echo "ddns: zone $DDNS_ZONE not found (token scope?)" >&2
        exit 1
      fi
      recs=$(cf -G "$api/zones/$zid/dns_records" --data-urlencode type=A --data-urlencode "name=$DDNS_NAME")
      rid=$(jq -r '.result[0].id // empty' <<<"$recs")
      cur=$(jq -r '.result[0].content // empty' <<<"$recs")
      body=$(jq -nc --arg name "$DDNS_NAME" --arg ip "$ip" '{type: "A", name: $name, content: $ip, ttl: 300, proxied: false}')
      if [ -z "$rid" ]; then
        cf -X POST "$api/zones/$zid/dns_records" --data "$body" >/dev/null
        echo "ddns: created $DDNS_NAME A $ip"
      elif [ "$cur" != "$ip" ]; then
        cf -X PATCH "$api/zones/$zid/dns_records/$rid" --data "$body" >/dev/null
        echo "ddns: updated $DDNS_NAME A $cur -> $ip"
      fi
    '';
  };

  # --- isolation (iptables; Docker uses the same backend) ---------------------
  # Dedicated chains, flushed and refilled on every firewall (re)start; the
  # jumps into them are checked before inserting and removed on stop. Nothing
  # here references the NixOS chains (nixos-fw-accept, …), so a rollback to a
  # generation without these stop commands still reloads cleanly.
  ipt = "iptables -w";
  chains = [ "lh-wg-in" "lh-wg-fwd" "lh-egress-ctr" "lh-egress-host" ];
  # [ chain rule… ]: the jump rules into our chains.
  jumps = [
    [ "nixos-fw" "-i" "wg0" "-m" "comment" "--comment" "lh: wg0 to this host" "-j" "lh-wg-in" ]
    [ "DOCKER-USER" "-i" "wg0" "-m" "comment" "--comment" "lh: wg0 forwarding" "-j" "lh-wg-fwd" ]
    # Also straight from FORWARD: covers the boot window before Docker hooks up DOCKER-USER.
    [ "FORWARD" "-i" "wg0" "-m" "comment" "--comment" "lh: wg0 forwarding" "-j" "lh-wg-fwd" ]
    [ "DOCKER-USER" "-i" "br-+" "-m" "comment" "--comment" "lh: container egress" "-j" "lh-egress-ctr" ]
    [ "DOCKER-USER" "-i" "docker0" "-m" "comment" "--comment" "lh: container egress" "-j" "lh-egress-ctr" ]
    [ "OUTPUT" "-m" "comment" "--comment" "lh: host egress" "-j" "lh-egress-host" ]
  ];
  rule = chain: args: "${ipt} -A ${chain} ${lib.escapeShellArgs args}";
  cmt = text: [ "-m" "comment" "--comment" "lh: ${text}" ];
  newConn = [ "-m" "conntrack" "--ctstate" "NEW" ];
  reject = [ "-j" "REJECT" "--reject-with" "icmp-admin-prohibited" ];
  replies = [ "-m" "conntrack" "--ctstate" "ESTABLISHED,RELATED" ];
  gatewayServices = chain: [
    (rule chain ([ "-d" gw "-p" "udp" "--dport" "53" ] ++ cmt "gateway DNS" ++ [ "-j" "RETURN" ]))
    (rule chain ([ "-d" gw "-p" "tcp" "--dport" "53" ] ++ cmt "gateway DNS" ++ [ "-j" "RETURN" ]))
    (rule chain ([ "-d" gw "-p" "udp" "--dport" "123" ] ++ cmt "gateway NTP" ++ [ "-j" "RETURN" ]))
  ];

  startCommands = lib.concatLines (
    [ "# --- LearnHarness WireGuard + LAN isolation (deploy/nixos/wireguard.nix) ---" ]
    ++ map (c: "${ipt} -N ${c} 2>/dev/null || true; ${ipt} -F ${c}") chains
    ++ [ "${ipt} -N DOCKER-USER 2>/dev/null || true" ]

    # wg0 -> this host (INPUT): Caddy only. No SSH, not even on 10.66.0.1.
    ++ [
      (rule "lh-wg-in" ([ "-p" "tcp" "-m" "multiport" "--dports" "80,443" ] ++ cmt "wg0 may reach Caddy" ++ [ "-j" "ACCEPT" ]))
      (rule "lh-wg-in" (cmt "nothing else from wg0" ++ [ "-j" "DROP" ]))
    ]

    # wg0 -> forwarded: only Docker's DNAT to Caddy's published 80/443. That
    # also means no forwarding into the LAN (or to the internet) from wg0.
    ++ [
      (rule "lh-wg-fwd" ([ "-p" "tcp" "-m" "conntrack" "--ctstate" "DNAT" "--ctorigdstport" "80" ] ++ cmt "wg0 to Caddy :80" ++ [ "-j" "RETURN" ]))
      (rule "lh-wg-fwd" ([ "-p" "tcp" "-m" "conntrack" "--ctstate" "DNAT" "--ctorigdstport" "443" ] ++ cmt "wg0 to Caddy :443" ++ [ "-j" "RETURN" ]))
      (rule "lh-wg-fwd" (cmt "no other forwarding from wg0, LAN included" ++ [ "-j" "DROP" ]))
    ]

    # Containers -> LAN (DOCKER-USER, -i docker0/br-*). RETURN hands the packet
    # back to Docker's own rules; only new connections into private ranges are
    # refused. Container-to-container traffic (-o br-*/docker0) is Docker's.
    ++ [
      (rule "lh-egress-ctr" (replies ++ cmt "replies" ++ [ "-j" "RETURN" ]))
      (rule "lh-egress-ctr" ([ "-o" "br-+" ] ++ cmt "container to container" ++ [ "-j" "RETURN" ]))
      (rule "lh-egress-ctr" ([ "-o" "docker0" ] ++ cmt "container to container" ++ [ "-j" "RETURN" ]))
    ]
    ++ gatewayServices "lh-egress-ctr"
    ++ [
      (rule "lh-egress-ctr" ([ "-d" "10.66.0.0/24" ] ++ cmt "wireguard peers" ++ [ "-j" "RETURN" ]))
      (rule "lh-egress-ctr" ([ "-d" "192.168.0.0/16" ] ++ newConn ++ cmt "no new connections into the LAN" ++ reject))
      (rule "lh-egress-ctr" ([ "-d" "10.0.0.0/8" ] ++ newConn ++ cmt "no new connections into the LAN" ++ reject))
    ]

    # This host -> LAN (OUTPUT). Replies (SSH from the LAN) and mid-stream TCP
    # pass first; only new connections into private ranges are refused.
    ++ [
      (rule "lh-egress-host" (replies ++ cmt "replies" ++ [ "-j" "RETURN" ]))
      # A TCP packet without SYN cannot open a connection; letting it pass keeps
      # an SSH session alive even if its conntrack entry was lost.
      (rule "lh-egress-host" ([ "-p" "tcp" "!" "--syn" ] ++ cmt "mid-stream TCP" ++ [ "-j" "RETURN" ]))
      (rule "lh-egress-host" ([ "-m" "addrtype" "--dst-type" "LOCAL" ] ++ cmt "own addresses" ++ [ "-j" "RETURN" ]))
      (rule "lh-egress-host" ([ "-o" "br-+" ] ++ cmt "host to containers" ++ [ "-j" "RETURN" ]))
      (rule "lh-egress-host" ([ "-o" "docker0" ] ++ cmt "host to containers" ++ [ "-j" "RETURN" ]))
      (rule "lh-egress-host" ([ "-p" "udp" "--sport" "68" "--dport" "67" ] ++ cmt "DHCP renewals" ++ [ "-j" "RETURN" ]))
    ]
    ++ gatewayServices "lh-egress-host"
    ++ [
      (rule "lh-egress-host" ([ "-d" "10.66.0.0/24" ] ++ cmt "wireguard peers" ++ [ "-j" "RETURN" ]))
      (rule "lh-egress-host" ([ "-d" "192.168.0.0/16" ] ++ newConn ++ cmt "no new connections into the LAN" ++ reject))
      (rule "lh-egress-host" ([ "-d" "10.0.0.0/8" ] ++ newConn ++ cmt "no new connections into the LAN" ++ reject))
      (rule "lh-egress-host" ([ "-d" "172.16.0.0/12" ] ++ newConn ++ cmt "no new connections into the LAN" ++ reject))
    ]

    # The jumps, last, once each.
    ++ map (j: let c = lib.head j; r = lib.escapeShellArgs (lib.tail j); in
      "${ipt} -C ${c} ${r} 2>/dev/null || ${ipt} -I ${c} 1 ${r}") jumps
  );

  stopCommands = lib.concatLines (
    [ "# --- LearnHarness WireGuard + LAN isolation: remove ---" ]
    ++ map (j: let c = lib.head j; r = lib.escapeShellArgs (lib.tail j); in
      "while ${ipt} -D ${c} ${r} 2>/dev/null; do :; done") jumps
    ++ map (c: "${ipt} -F ${c} 2>/dev/null || true; ${ipt} -X ${c} 2>/dev/null || true") chains
  );
in
{
  options.services.learnharness.wireguard = {
    enable = lib.mkEnableOption "WireGuard remote access to LearnHarness (wg0, peers from the app)";
    endpoint = lib.mkOption {
      type = lib.types.str;
      default = "vpn.moyjak.com";
      description = "Public name clients connect to (written to server.json as endpoint:port).";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 51820;
      description = "UDP listen port of wg0 (forward it on the router).";
    };
    ddnsName = lib.mkOption {
      type = lib.types.str;
      default = "vpn.moyjak.com";
      description = "A record kept on the WAN IPv4 (Cloudflare, CLOUDFLARE_API_TOKEN in secrets.env).";
    };
    ddnsZone = lib.mkOption {
      type = lib.types.str;
      default = "moyjak.com";
      description = "Cloudflare zone holding ddnsName.";
    };
    lanGateway = lib.mkOption {
      type = lib.types.str;
      default = "192.168.178.1";
      description = "The LAN router: the one LAN address the VM may query for DNS and NTP.";
    };
  };

  config = lib.mkIf cfg.enable {
    networking.wireguard.interfaces.wg0 = {
      ips = [ "10.66.0.1/24" ];
      listenPort = cfg.port;
      privateKeyFile = keyFile;
      generatePrivateKeyFile = true;
      # No static peers: wg-apply.py syncs them from the app.
    };

    networking.firewall.allowedUDPPorts = [ cfg.port ];
    networking.firewall.extraCommands = startCommands;
    networking.firewall.extraStopCommands = stopCommands;

    environment.systemPackages = [ pkgs.wireguard-tools ];

    systemd.services.learnharness-wg-apply = {
      description = "LearnHarness: apply WireGuard peers from the app, refresh server.json/status.json";
      # (Re)creating wg0 drops every peer; re-apply right after.
      wantedBy = [ "wireguard-wg0.service" ];
      after = [ "wireguard-wg0.service" ];
      path = [ pkgs.wireguard-tools pkgs.iproute2 ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = applier;
        PrivateTmp = true;
      };
    };
    # Runs on every change to peers.json…
    systemd.paths.learnharness-wg-apply = {
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = "${wgDir}/peers.json";
    };
    # …and every minute: the full apply is idempotent (`wg syncconf` changes
    # only what differs) and refreshes status.json. It also covers the cases
    # the path unit misses: PathChanged does not fire when peers.json is
    # created (first device), only once it exists.
    systemd.timers.learnharness-wg-status = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "minutely";
        AccuracySec = "5s";
        Unit = "learnharness-wg-apply.service";
      };
    };

    systemd.services.learnharness-ddns = {
      description = "LearnHarness: keep ${cfg.ddnsName} on the WAN IPv4 (Cloudflare)";
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      environment = {
        DDNS_NAME = cfg.ddnsName;
        DDNS_ZONE = cfg.ddnsZone;
      };
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${ddns}/bin/learnharness-ddns";
        # Read by systemd as root; the script itself runs unprivileged.
        EnvironmentFile = "-${stateDir}/secrets.env";
        DynamicUser = true;
      };
    };
    systemd.timers.learnharness-ddns = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "1min";
        OnUnitActiveSec = "5min";
      };
    };
  };
}
