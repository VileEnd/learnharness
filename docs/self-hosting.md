# Self-hosting (Docker, home network)

LearnHarness runs as one Docker image, the Next standalone server plus a Chromium for demo verification. You open it from any browser on the home network, and you can install it as an app (PWA). The app has no login of its own. The `deploy/` stack puts it behind Keycloak:

```
browser ──HTTPS──▶ Caddy ──forward_auth──▶ oauth2-proxy ──OIDC──▶ Keycloak (+ Postgres)
                     └─────────────────────▶ LearnHarness  (data + keys on ./volumes/learnharness)
```

- **Caddy** terminates HTTPS with its own local CA. Each device trusts that CA once.
- **oauth2-proxy** lets a request through only if the user is logged in to Keycloak and is a member of the group `learnharness`.
- **One shared data set.** Every allowed user sees the same chats, knowledge graph, and API keys.
- **API keys** are entered in the browser under Settings → Providers. They're stored on the server in `volumes/learnharness/auth.json`, never in the browser.

## Hostnames

| | App | Keycloak |
|---|---|---|
| Before UniFi move day (FRITZ!Box DNS) | `https://learnharness.fritz.box` | `https://learnharness.fritz.box:8443` |
| After move day (UniFi DNS records) | `https://learnharness.home.arpa` | `https://auth.home.arpa` |

All names live in `deploy/.env`. See [Move-day switch](#move-day-switch).

## 1. Create the VM (OpenTofu + NixOS)

The VM is declared in code. `deploy/proxmox/` is OpenTofu, which creates VM 104 `learnharness` on the home Proxmox. `deploy/nixos/` is a NixOS flake that declares the machine: Docker, the firewall, SSH (key only), and `learnharness-stack.service`, which checks out this repo and runs the compose stack. Nothing needs installing besides Nix; OpenTofu runs through `nix run`.

**One-time setup on the workstation (WSL):**
- `~/.config/learnharness/proxmox.env` (mode 600, never committed):
  ```bash
  export PROXMOX_VE_ENDPOINT=https://192.168.178.67:8006/
  export PROXMOX_VE_API_TOKEN=terraform@pve!tofu=<secret>   # pveum user token add terraform@pve tofu --privsep 0 (role PVEAdmin on /)
  export PROXMOX_VE_INSECURE=true
  export TF_VAR_state_passphrase=<random>                   # back this up: it decrypts the committed state
  ```
- Nix must be allowed to build VM disk images (KVM):
  ```bash
  echo "extra-system-features = kvm" | sudo tee -a /etc/nix/nix.conf && for u in $(getent group nixbld | cut -d: -f4 | tr , ' '); do sudo usermod -aG kvm "$u"; done && sudo systemctl restart nix-daemon
  ```

**Create the VM:**
```bash
deploy/proxmox/tofu.sh init
deploy/proxmox/tofu.sh plan
deploy/proxmox/tofu.sh apply      # uploads the NixOS image, creates and starts VM 104
```

- **What happens on first boot:** the VM boots fully configured, gets its address by DHCP (hostname `learnharness`, so the FRITZ!Box serves `learnharness.fritz.box`), and builds and starts the stack. The first image build takes 10–20 minutes. Follow it with `ssh root@learnharness.fritz.box journalctl -fu learnharness-stack`.
- **Pin the address:** in the FRITZ!Box, go to Heimnetz → Netzwerk → `learnharness` → *Diesem Netzwerkgerät immer die gleiche IPv4-Adresse zuweisen*.
- **Secrets** (Keycloak admin, database, OIDC client, cookie) are generated on the VM at first start. They live in `/var/lib/learnharness/secrets.env` and never leave it. App data, the Caddy CA and the Keycloak database live in `/var/lib/learnharness/volumes`.
- **The OpenTofu state** is committed to the repo, encrypted with `TF_VAR_state_passphrase`. If the passphrase is lost, `tofu import proxmox_virtual_environment_vm.learnharness pve/104` re-adopts the VM.
- **The image only bootstraps the VM.** `prevent_destroy` protects the VM, and rebuilt images never replace its disk.

**Change the machine** (NixOS options, packages, hostnames). Edit `deploy/nixos/`, then:
```bash
nix run nixpkgs#nixos-rebuild -- switch --flake ./deploy/nixos#learnharness --target-host root@learnharness.fritz.box
```

**Update the app** to the latest `main`:
```bash
ssh root@learnharness.fritz.box systemctl restart learnharness-stack
```

### Manual alternative (any Docker host)

On any Linux host with Docker, clone the repo, then:
```bash
cd learnharness/deploy && cp .env.example .env && nano .env && docker compose up -d --build
```

## 3. Trust the local CA on each device

Copy Caddy's root certificate from the VM. On the NixOS VM it's `/var/lib/learnharness/volumes/caddy/data/caddy/pki/authorities/local/root.crt`; on a manual host it's under `deploy/volumes/`. From Windows: `scp root@learnharness.fritz.box:/var/lib/learnharness/volumes/caddy/data/caddy/pki/authorities/local/root.crt .`

- **Windows:** in PowerShell, run `Import-Certificate -FilePath root.crt -CertStoreLocation Cert:\CurrentUser\Root`. Chrome and Edge use the Windows store.
- **Android:** Settings → Security → Encryption & credentials → Install a certificate → *CA certificate*.
- **iPhone/iPad:** send the file to the device (AirDrop or mail) → Settings → *Profile downloaded* → Install. Then General → About → Certificate Trust Settings → turn the certificate on.
- **Linux (EndeavourOS):** `sudo trust anchor --store root.crt`. Firefox: about:config → `security.enterprise_roots.enabled` = true.

The CA stays the same when hostnames change, so you only do this once per device. Back up `volumes/caddy`.

## 4. Create users (Keycloak)

1. Open `https://learnharness.fritz.box:8443/admin` and log in with `KC_ADMIN_USER` / `KC_ADMIN_PASSWORD`. On the NixOS VM: `ssh root@learnharness.fritz.box cat /var/lib/learnharness/secrets.env`.
2. Switch to the realm **learnharness**.
3. For each person: go to Users → *Create new user* and set a username and email. Under *Credentials*, set a password (*Temporary* off if you like). Under *Groups*, join **learnharness**.

Someone who can log in but is not in the group gets a 403 from oauth2-proxy.

## 5. Use it

- Open `https://learnharness.fritz.box` and log in.
- Add your provider API key under Settings → Providers, then pick the strong, cheap, and vision models.
- **Install as an app:**
  - Chrome or Edge: use the install icon in the address bar.
  - Android: Chrome menu → *Install app*.
  - iOS: Safari → Share → *Add to Home Screen*.
- Dictation (Deepgram) and clipboard copy need HTTPS, which the stack provides.

## 6. Migrate data from the Windows desktop app

The desktop app stored everything in `%APPDATA%\LearnHarness` (`C:\Users\<you>\AppData\Roaming\LearnHarness`). Its ChatGPT/Copilot/Grok subscription logins don't exist in the browser version. Its `*-credentials.json` files are **not** migrated, and any model that pointed at a subscription is rewritten to an API-key model you choose.

1. Quit the desktop app.
2. In WSL, copy the data and keys:
   ```bash
   mkdir -p ~/lh-migrate
   cp -r /mnt/c/Users/<you>/AppData/Roaming/LearnHarness/data ~/lh-migrate/data
   cp /mnt/c/Users/<you>/AppData/Roaming/LearnHarness/auth.json ~/lh-migrate/auth.json
   ```
3. Rewrite subscription model routes. Do a dry run first, then `--write`. Run this from a checkout of the repo, after `npm ci`:
   ```bash
   LH_DATA_DIR=~/lh-migrate/data npx tsx scripts/migrate-subscription-routes.ts --to <provider>/<modelId>
   LH_DATA_DIR=~/lh-migrate/data npx tsx scripts/migrate-subscription-routes.ts --to <provider>/<modelId> --write
   ```
   `<provider>/<modelId>` is the pi-ai catalog id, for example `anthropic/claude-sonnet-5-5` or `openrouter/z-ai/glm-5.3-flash`.
4. Copy the files to the VM. These commands are for the NixOS VM; on a manual host, copy into `deploy/volumes/learnharness/` with `sudo`. The container hands the files to its own user when it starts:
   ```bash
   scp -r ~/lh-migrate root@learnharness.fritz.box:/root/
   ssh root@learnharness.fritz.box 'docker stop learnharness-learnharness-1 && cp -r /root/lh-migrate/data /root/lh-migrate/auth.json /var/lib/learnharness/volumes/learnharness/ && chmod 600 /var/lib/learnharness/volumes/learnharness/auth.json && docker start learnharness-learnharness-1 && rm -rf /root/lh-migrate'
   ```
5. Check that your chats, graph, and keys are there. Once you're happy, uninstall the desktop app. `%APPDATA%\LearnHarness` stays behind as a fallback copy.

## Updating

```bash
ssh root@learnharness.fritz.box systemctl restart learnharness-stack     # NixOS VM: pulls main, rebuilds
cd ~/learnharness && git pull && cd deploy && docker compose up -d --build   # manual host
```

## Backups

Back up the volumes (app data and keys, Caddy CA, Keycloak database) and the secrets. On the NixOS VM that's `/var/lib/learnharness/volumes/` and `/var/lib/learnharness/secrets.env`; on a manual host, `deploy/volumes/` and `deploy/.env`. A Proxmox backup job (vzdump) of VM 104 covers everything.

## Move-day switch

When the UniFi gateway takes over the LAN (`/home/test/network/fritzbox-to-unifi-plan.md`), the VM moves to **10.20.1.70** and the FRITZ!Box names stop resolving.

1. **UniFi:** add a DHCP reservation `.70` for the VM's MAC, or set the address statically on the VM.
2. **UniFi DNS:** add host records `learnharness.home.arpa` and `auth.home.arpa` → `10.20.1.70`. *(Verify where your UniFi Network version keeps local DNS records.)*
3. **Hostnames:**
   - **NixOS VM:** set them in `deploy/nixos/configuration.nix`, then run the `nixos-rebuild switch … --target-host` command from section 1. The stack restarts with the new values.
     ```nix
     services.learnharness = {
       host = "learnharness.home.arpa";
       authSite = "auth.home.arpa";
       authUrl = "https://auth.home.arpa";
     };
     ```
   - **Manual host:** switch `deploy/.env` to the "After the move day" block (`LH_HOST`, `AUTH_SITE`, `AUTH_URL`).
4. **Keycloak** (at its *old* URL, before restarting, or at the new one after): realm learnharness → Clients → `learnharness` → set *Valid redirect URIs* to `https://learnharness.home.arpa/oauth2/callback`, *Web origins* to `https://learnharness.home.arpa`, and *Valid post logout redirect URIs* to `https://learnharness.home.arpa/*`.
5. On a manual host, run `docker compose up -d`; the NixOS rebuild already did this. Caddy issues certificates for the new names from the same CA.
6. Log in again on each device and reinstall the PWA from the new address. No certificate re-trust is needed.

## Troubleshooting

- `docker compose logs -f oauth2-proxy keycloak caddy learnharness`
- **Redirect loop or 500 at login:** check that `AUTH_URL`, `KC_HOSTNAME` and the client's redirect URI all use the current hostnames.
- **403 after login:** the user isn't in the `learnharness` group.
- **Demos fail with "No render engine available":** the image is missing Chromium. Rebuild with `docker compose build --no-cache learnharness`.
