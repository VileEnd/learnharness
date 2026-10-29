{ config, lib, pkgs, ... }:

# Runs the deploy/ Docker stack from a checkout of the fork. Hostnames are
# Nix options (the move-day switch is a change here + nixos-rebuild);
# secrets are generated on the VM on first start and never leave it.
let
  cfg = config.services.learnharness;
  stateDir = "/var/lib/learnharness";
  hostsEnv = pkgs.writeText "learnharness-hosts.env" ''
    LH_HOST=${cfg.host}
    AUTH_SITE=${cfg.authSite}
    AUTH_URL=${cfg.authUrl}
    CADDY_TLS=${cfg.tls}
  '';
in
{
  options.services.learnharness = {
    repo = lib.mkOption {
      type = lib.types.str;
      default = "https://github.com/VileEnd/learnharness.git";
      description = "Git repository holding Dockerfile + deploy/.";
    };
    ref = lib.mkOption {
      type = lib.types.str;
      default = "main";
      description = "Branch or tag to deploy (restart the service to pull it).";
    };
    host = lib.mkOption {
      type = lib.types.str;
      default = "learnharness.fritz.box";
      description = "The app's hostname (LH_HOST).";
    };
    authSite = lib.mkOption {
      type = lib.types.str;
      default = "learnharness.fritz.box:8443";
      description = "Caddy site address for Keycloak (AUTH_SITE).";
    };
    authUrl = lib.mkOption {
      type = lib.types.str;
      default = "https://learnharness.fritz.box:8443";
      description = "Keycloak's public URL (AUTH_URL, KC_HOSTNAME).";
    };
    tls = lib.mkOption {
      type = lib.types.enum [ "internal" "cloudflare" ];
      default = "internal";
      description = ''
        Certificate source (CADDY_TLS). "cloudflare" = Let's Encrypt via the
        Cloudflare DNS challenge and needs CLOUDFLARE_API_TOKEN in
        /var/lib/learnharness/secrets.env (put there by hand, never in Nix).
      '';
    };
  };

  config = {
    virtualisation.docker.enable = true;

    systemd.services.learnharness-stack = {
      description = "LearnHarness Docker stack (Caddy, oauth2-proxy, Keycloak, app, OCR)";
      wantedBy = [ "multi-user.target" ];
      requires = [ "docker.service" ];
      wants = [ "network-online.target" ];
      after = [ "docker.service" "network-online.target" ];
      # A hostname change (nixos-rebuild) re-runs the stack with the new values.
      restartTriggers = [ hostsEnv ];
      path = with pkgs; [ git docker openssl coreutils gnused gnugrep ];
      # Retry until the network (DHCP, GitHub, registries) is really there —
      # network-online.target can be reached before the first lease.
      startLimitIntervalSec = 0;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        StateDirectory = "learnharness";
        # The first start builds the app image (npm ci + next build).
        TimeoutStartSec = "60min";
        Restart = "on-failure";
        RestartSec = "30s";
      };
      script = ''
        set -euo pipefail
        src=${stateDir}/src
        if [ ! -d "$src/.git" ]; then
          git clone ${lib.escapeShellArg cfg.repo} "$src"
        fi
        git -C "$src" fetch --prune --tags origin ${lib.escapeShellArg cfg.ref}
        git -C "$src" checkout --quiet --detach FETCH_HEAD

        # Runtime state lives outside the checkout: deploy/volumes (git-ignored)
        # points at ${stateDir}/volumes.
        mkdir -p ${stateDir}/volumes
        ln -sfn ${stateDir}/volumes "$src/deploy/volumes"

        secrets=${stateDir}/secrets.env
        if [ ! -f "$secrets" ]; then
          umask 077
          {
            echo "KC_ADMIN_USER=admin"
            echo "KC_ADMIN_PASSWORD=$(openssl rand -hex 16)"
            echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
            echo "OIDC_CLIENT_SECRET=$(openssl rand -hex 32)"
            echo "OAUTH2_COOKIE_SECRET=$(openssl rand -base64 32 | tr -- '+/' '-_')"
            echo "OCR_TOKEN=$(openssl rand -hex 32)"
            echo "KC_ADMIN_API_SECRET=$(openssl rand -hex 32)"
          } > "$secrets"
        fi
        # secrets.env of an older install has no OCR_TOKEN yet (PDF scanning service): add it once.
        grep -q '^OCR_TOKEN=' "$secrets" || (umask 077; echo "OCR_TOKEN=$(openssl rand -hex 32)" >> "$secrets")
        # …nor KC_ADMIN_API_SECRET (the app's Keycloak client for the admin Users section).
        grep -q '^KC_ADMIN_API_SECRET=' "$secrets" || (umask 077; echo "KC_ADMIN_API_SECRET=$(openssl rand -hex 32)" >> "$secrets")

        cd "$src/deploy"
        docker compose --env-file ${hostsEnv} --env-file "$secrets" up -d --build --remove-orphans
        # The Caddyfile is a bind mount: compose does not notice content changes,
        # so apply them explicitly (a no-op when nothing changed).
        docker compose --env-file ${hostsEnv} --env-file "$secrets" exec -T caddy \
          caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || true

        # Group, admin-API client (secret = KC_ADMIN_API_SECRET) and its roles in
        # the realm, idempotently. It waits up to 3 minutes for Keycloak and never
        # fails the stack: on failure it logs "keycloak bootstrap failed".
        ${pkgs.bash}/bin/bash ${./bootstrap-keycloak.sh} "$secrets" || echo "keycloak bootstrap failed"
      '';
    };
  };
}
