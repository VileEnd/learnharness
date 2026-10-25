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

## 1. Create the VM (Proxmox)

In the Proxmox UI (`https://192.168.178.67:8006`) create a VM:

- **ISO:** Debian 13 netinst. **Name / hostname:** `learnharness`. The FRITZ!Box publishes the hostname as `learnharness.fritz.box`.
- **Hardware:** 2 vCPU (type `host`), 4 GB RAM, a 32 GB disk, VirtIO NIC on `vmbr0`.
- **Options:** enable *QEMU Guest Agent* and *Start at boot*.
- **Install:** SSH server plus standard system utilities, no desktop. After install, run `apt install qemu-guest-agent sudo git`.
- **FRITZ!Box:** go to Heimnetz → Netzwerk → `learnharness` → *Diesem Netzwerkgerät immer die gleiche IPv4-Adresse zuweisen* and give it **192.168.178.70**.

## 2. Install Docker and start the stack

On the VM:

```bash
# Docker Engine from Docker's Debian repository
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"   # log out and back in

git clone https://github.com/VileEnd/learnharness.git ~/learnharness
cd ~/learnharness/deploy
cp .env.example .env
nano .env          # fill in every secret (the file says how to generate each)
docker compose up -d --build
docker compose ps  # all services "running"; learnharness turns "healthy" after ~30 s
```

The first build takes a few minutes. It runs the standalone gates and checks that Chromium can drive a demo page inside the image.

## 3. Trust the local CA on each device

Copy `deploy/volumes/caddy/data/caddy/pki/authorities/local/root.crt` from the VM. For example, from Windows: `scp <user>@learnharness.fritz.box:~/learnharness/deploy/volumes/caddy/data/caddy/pki/authorities/local/root.crt .`

- **Windows:** in PowerShell, run `Import-Certificate -FilePath root.crt -CertStoreLocation Cert:\CurrentUser\Root`. Chrome and Edge use the Windows store.
- **Android:** Settings → Security → Encryption & credentials → Install a certificate → *CA certificate*.
- **iPhone/iPad:** send the file to the device (AirDrop or mail) → Settings → *Profile downloaded* → Install. Then General → About → Certificate Trust Settings → turn the certificate on.
- **Linux (EndeavourOS):** `sudo trust anchor --store root.crt`. Firefox: about:config → `security.enterprise_roots.enabled` = true.

The CA stays the same when hostnames change, so you only do this once per device. Back up `volumes/caddy`.

## 4. Create users (Keycloak)

1. Open `https://learnharness.fritz.box:8443/admin` and log in with `KC_ADMIN_USER` / `KC_ADMIN_PASSWORD`.
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
4. Copy the files to the VM through a staging folder. The data volume belongs to the container's user, so copy into it with `sudo`. The container hands the files to its own user when it starts:
   ```bash
   scp -r ~/lh-migrate <user>@learnharness.fritz.box:~/
   ssh -t <user>@learnharness.fritz.box 'cd ~/learnharness/deploy && docker compose stop learnharness && sudo cp -r ~/lh-migrate/data ~/lh-migrate/auth.json volumes/learnharness/ && sudo chmod 600 volumes/learnharness/auth.json && docker compose up -d && rm -rf ~/lh-migrate'
   ```
5. Check that your chats, graph, and keys are there. Once you're happy, uninstall the desktop app. `%APPDATA%\LearnHarness` stays behind as a fallback copy.

## Updating

```bash
cd ~/learnharness && git pull && cd deploy && docker compose up -d --build
```

## Backups

Back up `deploy/volumes/` (app data and keys, Caddy CA, Keycloak database) and `deploy/.env`. A Proxmox backup job (vzdump) of the whole VM covers everything.

## Move-day switch

When the UniFi gateway takes over the LAN (`/home/test/network/fritzbox-to-unifi-plan.md`), the VM moves to **10.20.1.70** and the FRITZ!Box names stop resolving.

1. **UniFi:** add a DHCP reservation `.70` for the VM's MAC, or set the address statically on the VM.
2. **UniFi DNS:** add host records `learnharness.home.arpa` and `auth.home.arpa` → `10.20.1.70`. *(Verify where your UniFi Network version keeps local DNS records.)*
3. **`deploy/.env`:** switch to the "After the move day" block (`LH_HOST`, `AUTH_SITE`, `AUTH_URL`).
4. **Keycloak** (at its *old* URL, before restarting, or at the new one after): realm learnharness → Clients → `learnharness` → set *Valid redirect URIs* to `https://learnharness.home.arpa/oauth2/callback`, *Web origins* to `https://learnharness.home.arpa`, and *Valid post logout redirect URIs* to `https://learnharness.home.arpa/*`.
5. Run `docker compose up -d`. Caddy issues certificates for the new names from the same CA.
6. Log in again on each device and reinstall the PWA from the new address. No certificate re-trust is needed.

## Troubleshooting

- `docker compose logs -f oauth2-proxy keycloak caddy learnharness`
- **Redirect loop or 500 at login:** check that `AUTH_URL`, `KC_HOSTNAME` and the client's redirect URI all use the current hostnames.
- **403 after login:** the user isn't in the `learnharness` group.
- **Demos fail with "No render engine available":** the image is missing Chromium. Rebuild with `docker compose build --no-cache learnharness`.
