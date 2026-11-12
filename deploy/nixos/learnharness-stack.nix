{ config, lib, pkgs, utils, ... }:

# Runs the deploy/ Docker stack from a checkout of the fork. Hostnames are
# Nix options (the move-day switch is a change in the site file +
# deploy/nixos/rebuild.sh); secrets are generated on the VM on first start
# and never leave it.
#
# Deploys are explicit and boots never build (docs/self-hosting.md, Updating):
#   learnharness-stack        boot/restart: starts the last deploy's checkout and
#                             images; no fetch, no build. On a machine where
#                             nothing was ever deployed it deploys `ref` once.
#   learnharness-deploy@T     T = latest (newest vX.Y.Z tag), a tag, or a branch:
#                             fetch, build images tagged with the commit, start
#                             them, wait for the app to be healthy, else go back.
#   learnharness-rollback     back to the previous deploy, without building.
# deploy.py makes the decisions and keeps the state in
# /var/lib/learnharness/deploy-state.json; these units lock, prepare and call it.
let
  cfg = config.services.learnharness;
  stateDir = "/var/lib/learnharness";
  hostsEnv = pkgs.writeText "learnharness-hosts.env" ''
    LH_HOST=${cfg.host}
    AUTH_SITE=${cfg.authSite}
    AUTH_URL=${cfg.authUrl}
    CADDY_TLS=${cfg.tls}
  '';
  # One start, deploy, rollback or prune at a time.
  lockFile = "${stateDir}/deploy.lock";
  deployArgv = [
    "${pkgs.python3}/bin/python3" "-I" "-B" "${./deploy.py}"
    "--src" "${stateDir}/src"
    "--state" "${stateDir}/deploy-state.json"
    "--hosts-env" "${hostsEnv}"
    "--secrets" "${stateDir}/secrets.env"
    "--keycloak-bootstrap" "${./bootstrap-keycloak.sh}"
  ];
  deployCmd = lib.escapeShellArgs deployArgv;
  unitPath = with pkgs; [ git docker openssl coreutils gnused gnugrep util-linux bash ];

  # Shared by the three units: take the lock (start waits for it, deploy and
  # rollback refuse while it is held), then the checkout, volumes and secrets.
  # deploy.py inherits fd 9 and so holds the lock until it exits.
  takeLock = wait:
    if wait then "flock 9"
    else ''flock -n 9 || { echo "learnharness: another deploy, rollback or prune is running; try again when it has finished" >&2; exit 1; }'';
  prepare = wait: ''
    set -euo pipefail
    exec 9>>${lockFile}
    ${takeLock wait}

    src=${stateDir}/src
    if [ ! -d "$src/.git" ]; then
      git clone ${lib.escapeShellArg cfg.repo} "$src"
    fi

    # Runtime state lives outside the checkout: deploy/volumes (git-ignored)
    # points at ${stateDir}/volumes.
    mkdir -p ${stateDir}/volumes
    ln -sfn ${stateDir}/volumes "$src/deploy/volumes"
    # The claude container runs as node (uid 1000) and keeps its login here.
    install -d -m 0700 -o 1000 -g 1000 ${stateDir}/volumes/claude

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
        echo "CLAUDE_RUNNER_TOKEN=$(openssl rand -hex 32)"
      } > "$secrets"
    fi
    # secrets.env of an older install has no OCR_TOKEN yet (PDF scanning service): add it once.
    grep -q '^OCR_TOKEN=' "$secrets" || (umask 077; echo "OCR_TOKEN=$(openssl rand -hex 32)" >> "$secrets")
    # …nor KC_ADMIN_API_SECRET (the app's Keycloak client for the admin Users section).
    grep -q '^KC_ADMIN_API_SECRET=' "$secrets" || (umask 077; echo "KC_ADMIN_API_SECRET=$(openssl rand -hex 32)" >> "$secrets")
    # …nor CLAUDE_RUNNER_TOKEN (the app's token for the Claude Code runner).
    grep -q '^CLAUDE_RUNNER_TOKEN=' "$secrets" || (umask 077; echo "CLAUDE_RUNNER_TOKEN=$(openssl rand -hex 32)" >> "$secrets")
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
      default = "latest";
      description = ''
        What the boot deploys on a machine where nothing was deployed yet:
        "latest" (the newest vX.Y.Z tag), a tag, or a branch. Later deploys
        name their target: systemctl start learnharness-deploy@<target>.
      '';
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
    # Every deploy builds images on a small disk: prune weekly. Unused images
    # and build cache older than a week go; recent cache stays so redeploys
    # remain fast. No --volumes: the bind-mounted data is untouched.
    virtualisation.docker.autoPrune = {
      enable = true;
      dates = "weekly";
      flags = [ "--all" "--filter" "until=168h" ];
    };
    # The previous deploy's images are used by no container, and --all with
    # until=168h removes unused images built more than a week ago: a rollback
    # target could go in the first prune after the deploy that replaced it.
    # So deploy.py runs the prune under the deploy lock, with stopped
    # containers holding the current and previous images while it runs.
    systemd.services.docker-prune = {
      path = [ config.virtualisation.docker.package ];
      serviceConfig.StateDirectory = "learnharness";
      serviceConfig.ExecStart = lib.mkForce [
        (utils.escapeSystemdExecArgs (
          [ "${pkgs.util-linux}/bin/flock" lockFile ] ++ deployArgv
          ++ [ "prune" "--" (lib.getExe config.virtualisation.docker.package) "system" "prune" "-f" ]
          ++ config.virtualisation.docker.autoPrune.flags
        ))
      ];
    };

    systemd.services.learnharness-stack = {
      description = "LearnHarness Docker stack (Caddy, oauth2-proxy, Keycloak, app, OCR, Claude runner)";
      wantedBy = [ "multi-user.target" ];
      requires = [ "docker.service" ];
      wants = [ "network-online.target" ];
      after = [ "docker.service" "network-online.target" ];
      # A hostname change (nixos-rebuild) re-runs the stack with the new values.
      restartTriggers = [ hostsEnv ];
      path = unitPath;
      # Starting what is built only needs Docker: a failure there is retried.
      # Only a machine that never had a deploy fetches (and may need to wait
      # for the network); a failed build or an unusable deploy state exits 3,
      # which is not retried, so nothing is rebuilt in a loop.
      startLimitIntervalSec = 0;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        StateDirectory = "learnharness";
        # Only the first start on a new machine builds (npm ci + next build).
        TimeoutStartSec = "60min";
        Restart = "on-failure";
        RestartSec = "30s";
        RestartPreventExitStatus = 3;
      };
      script = ''
        ${prepare true}
        exec ${deployCmd} start --default-target ${lib.escapeShellArg cfg.ref}
      '';
    };

    # systemctl start learnharness-deploy@latest   (or @v1.2.3, or @main)
    systemd.services."learnharness-deploy@" = {
      description = "LearnHarness: deploy %I (fetch, build, start, wait for healthy)";
      requires = [ "docker.service" ];
      wants = [ "network-online.target" ];
      after = [ "docker.service" "network-online.target" ];
      path = unitPath;
      # A switch must not restart (and so cut short) a running deploy.
      restartIfChanged = false;
      serviceConfig = {
        Type = "oneshot";
        StateDirectory = "learnharness";
        TimeoutStartSec = "60min";
      };
      scriptArgs = "%I";
      script = ''
        ${prepare false}
        exec ${deployCmd} deploy "$1"
      '';
    };

    # systemctl start learnharness-rollback
    systemd.services.learnharness-rollback = {
      description = "LearnHarness: back to the previous deploy (no build)";
      requires = [ "docker.service" ];
      after = [ "docker.service" ];
      path = unitPath;
      restartIfChanged = false;
      serviceConfig = {
        Type = "oneshot";
        StateDirectory = "learnharness";
        TimeoutStartSec = "15min";
      };
      script = ''
        ${prepare false}
        exec ${deployCmd} rollback
      '';
    };
  };
}
