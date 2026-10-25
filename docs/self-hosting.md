# Self-hosting (Docker, home network)

LearnHarness runs as one Docker image, the Next standalone server plus a Chromium for demo verification. You open it from any browser on the home network, and you can install it as an app (PWA). The app has no login of its own. The `deploy/` stack puts it behind Keycloak:

```
browser ──HTTPS──▶ Caddy ──forward_auth──▶ oauth2-proxy ──OIDC──▶ Keycloak (+ Postgres)
                     └─────────────────────▶ LearnHarness  (data + keys on ./volumes/learnharness)
```

- **Caddy** terminates HTTPS. With `CADDY_TLS=cloudflare` (this deployment), certificates come from Let's Encrypt via the Cloudflare DNS challenge, so every device trusts them with no setup. With `CADDY_TLS=internal`, Caddy uses its own local CA, and each device must trust that CA once.
- **oauth2-proxy** lets a request through only if the user is logged in to Keycloak and is a member of the group `learnharness`.
- **One shared data set.** Every allowed user sees the same chats, knowledge graph, and API keys.
- **API keys** are entered in the browser under Settings → Providers. They're stored on the server in `volumes/learnharness/auth.json`, never in the browser.

## Hostnames

| | App | Keycloak |
|---|---|---|
| This deployment | `https://learnharness.home.moyjak.com` | `https://auth.home.moyjak.com` |

- **The records:** both names are public DNS records (Cloudflare, **DNS only**) pointing at the VM's **LAN** address. They resolve anywhere but only work at home. OpenTofu manages them in `deploy/proxmox/dns.tf`; the address is the variable `lan_ipv4`.
- **The router:** it must allow public names that resolve to private addresses. On the FRITZ!Box, go to Heimnetz → Netzwerk → Netzwerkeinstellungen → **DNS-Rebind-Schutz** and add `home.moyjak.com`. The UniFi gateway needs no exception unless you turn on its own rebinding protection.
- **Hostname settings:** they're NixOS options (`services.learnharness.*` in `deploy/nixos/configuration.nix`), or `deploy/.env` on a manual host.
- **Without a domain:** use `CADDY_TLS=internal` with any local names, for example `learnharness.fritz.box` with Keycloak on `:8443`, and trust Caddy's root once per device (section 3).

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
- With `CADDY_TLS=cloudflare`, add the Cloudflare token to the same file as `export CLOUDFLARE_API_TOKEN=…`; OpenTofu uses it for the DNS records. Put it on the VM too, so Caddy can use it. Run this in your own terminal; it prompts without echoing:
  ```bash
  ssh -t root@learnharness.fritz.box 'umask 077; read -rsp "Cloudflare token: " t; echo; sed -i "/^CLOUDFLARE_API_TOKEN=/d" /var/lib/learnharness/secrets.env; echo "CLOUDFLARE_API_TOKEN=$t" >> /var/lib/learnharness/secrets.env'
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

## 3. Trust the local CA on each device (only with `CADDY_TLS=internal`)

Skip this with `CADDY_TLS=cloudflare`: Let's Encrypt certificates are already trusted everywhere.


Copy Caddy's root certificate from the VM. On the NixOS VM it's `/var/lib/learnharness/volumes/caddy/data/caddy/pki/authorities/local/root.crt`; on a manual host it's under `deploy/volumes/`. From Windows: `scp root@learnharness.fritz.box:/var/lib/learnharness/volumes/caddy/data/caddy/pki/authorities/local/root.crt .`

- **Windows:** in PowerShell, run `Import-Certificate -FilePath root.crt -CertStoreLocation Cert:\CurrentUser\Root`. Chrome and Edge use the Windows store.
- **Android:** Settings → Security → Encryption & credentials → Install a certificate → *CA certificate*.
- **iPhone/iPad:** send the file to the device (AirDrop or mail) → Settings → *Profile downloaded* → Install. Then General → About → Certificate Trust Settings → turn the certificate on.
- **Linux (EndeavourOS):** `sudo trust anchor --store root.crt`. Firefox: about:config → `security.enterprise_roots.enabled` = true.

The CA stays the same when hostnames change, so you only do this once per device. Back up `volumes/caddy`.

## 4. Create users (Keycloak)

1. Open `https://auth.home.moyjak.com/admin` and log in with `KC_ADMIN_USER` / `KC_ADMIN_PASSWORD`. On the NixOS VM: `ssh root@learnharness.fritz.box cat /var/lib/learnharness/secrets.env`.
2. Switch to the realm **learnharness**.
3. For each person: go to Users → *Create new user* and set a username and email. Under *Credentials*, set a password (*Temporary* off if you like). Under *Groups*, join **learnharness**.

Someone who can log in but is not in the group gets a 403 from oauth2-proxy.

## 5. Use it

- Open `https://learnharness.home.moyjak.com` and log in.
- Add your provider API key under Settings → Providers, then pick the strong, cheap, and vision models.
- **Install as an app:**
  - Chrome or Edge: use the install icon in the address bar.
  - Android: Chrome menu → *Install app*.
  - iOS: Safari → Share → *Add to Home Screen*.
- **Notifications (optional, per device):** Settings → General → *Notifications on this device*. Tapping the switch asks the browser for permission and registers the device; you then get a push when the teacher replies while the app is not open on that chat, when a background task finishes or fails, and when a notes import finishes. On iOS and iPadOS (16.4+) push only works for the installed app: add it to the Home Screen first, then open it from there and enable the switch. Push needs HTTPS and a certificate the device trusts (see §3 for `CADDY_TLS=internal`). The server generates its VAPID keys on first use (`data/push/vapid.json`, mode 0600, kept on the data volume); no configuration is needed. If you delete that file, devices must switch notifications off and on again.
- **Add documents:** the graph's *Add documents…* button (or *Documents* in the sidebar) takes markdown, text, and PDF files. Each file is checked by its content, never its filename: a document you already imported shows *Already imported as …* and is skipped by default, a near-copy shows *92% similar to …* with *Skip / Replace / Import as new*. Everything you add is kept in the library (`/documents`, data in `data/documents/`) and fed into the knowledge graph; progress shows in the activity section and a push notification closes it. Markdown without a title or topics gets them from the cheap model. PDFs are scanned by the optional OCR service: set `OCR_URL` (and `OCR_TOKEN`) for the app container; without `OCR_URL`, PDFs are refused with a message and markdown still works. Scanning also needs an OpenRouter key under Settings → Providers, and the dialog shows the estimated scan cost before you confirm.
- **Your documents in a session:** the tutor can search and read what you added (`search_documents`, `read_document`, `list_documents`), so "help me with exercise 3 of the semaphore sheet" finds the sheet and cites it as "(title, p. 2)". The same search is the box on `/documents`. Settings → Agent → *Document tools* turns it off. Search is keyword-only until your documents are embedded; with an OpenRouter key (Settings → Providers) the app embeds them in the background (activity section, "Indexing …") using the model under Settings → Agent → Documents (default `google/gemini-embedding-2`, multilingual, 3072 dimensions) and search becomes hybrid. Indexing uses the OpenRouter *Batch API* by default (Settings → Agent → Documents → *Batch indexing*): about half the sync price, roughly $0.10 per million tokens for `gemini-embedding-2` ($0.20 sync; check the model page), so a library of a few hundred pages costs a cent or two. Results usually arrive within minutes and at most a day; the activity row reads "Indexing documents (batch) · waiting for OpenRouter" meanwhile, a bulk import is collected for about two minutes into one batch, and search is keyword-only for those documents until the batch returns. Pending batches are kept in `data/documents/pending-batches.json`, so a restart picks them up, and OpenRouter's copy is deleted once read. Turn the switch off for immediate, full-price indexing. Search queries always use the normal (sync) endpoint. Changing the model or pressing *Re-index* embeds everything again. Without a key, or if embedding fails, search still works on keywords and says so. Vectors live next to each document (`data/documents/<id>/vectors.f32`), so they belong in the same backups.
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

### Bringing over imports from the old app

The graph you migrated already holds the nodes the old app extracted from your notes, but the browser version has no stored documents for them yet. **Re-upload the original files once** (Add documents on the graph page). A file whose name matches an old import shows as "Already in your graph · imported <date> · N nodes — add to library (no re-extraction)", and Import attaches the file to the existing graph source: no model extraction runs, the document appears in the library, and a cheap model pass files the source's existing nodes under the document's topics so the graph's Topic grouping covers them too. Choose "Re-extract" for a file you want read again from scratch, or "Skip". Old imports of PDFs that were stored as raw text and produced no nodes are not adopted: upload the PDF again and it is scanned and extracted as a new document.

## PDF scanning service

The stack includes `ocr` (`services/ocr`), which turns uploaded PDFs into markdown through OpenRouter. It has no published port and no Caddy route: only the app reaches it at `http://ocr:8000`, and every call carries the shared secret `OCR_TOKEN` (generated into `secrets.env` on the NixOS VM, also for installs that predate it; on a manual host put the output of `openssl rand -hex 32` into `deploy/.env`). The OpenRouter key is the one in the app's Settings, sent per job. Results and cache live in `volumes/ocr/`, which belongs in the backups.

## Updating

```bash
ssh root@learnharness.fritz.box systemctl restart learnharness-stack     # NixOS VM: pulls main, rebuilds
cd ~/learnharness && git pull && cd deploy && docker compose up -d --build   # manual host
```

## Backups

Back up the volumes (app data and keys, Caddy CA, Keycloak database) and the secrets. On the NixOS VM that's `/var/lib/learnharness/volumes/` and `/var/lib/learnharness/secrets.env`; on a manual host, `deploy/volumes/` and `deploy/.env`. A Proxmox backup job (vzdump) of VM 104 covers everything.

## Move-day switch

When the UniFi gateway takes over the LAN (`/home/test/network/fritzbox-to-unifi-plan.md`), the VM moves to **10.20.1.70**. The hostnames and certificates stay the same; only the DNS records change:

1. **UniFi:** add a DHCP reservation `.70` for the VM's MAC (`BC:24:11:B3:41:E1`).
2. **Point the records at the new address:** run `deploy/proxmox/tofu.sh apply -var lan_ipv4=10.20.1.70`, or change the default in `variables.tf` and commit it.
3. That's it. Keycloak, redirect URIs and devices are unaffected; the TTL is 5 minutes.

With `CADDY_TLS=internal` and local names instead, change the hostnames (NixOS options or `deploy/.env`), update the Keycloak client's redirect URI, web origin and post-logout URI to the new app host, and restart the stack.

## Troubleshooting

- `docker compose logs -f oauth2-proxy keycloak caddy learnharness`
- **Redirect loop or 500 at login:** check that `AUTH_URL`, `KC_HOSTNAME` and the client's redirect URI all use the current hostnames.
- **403 after login:** the user isn't in the `learnharness` group.
- **Demos fail with "No render engine available":** the image is missing Chromium. Rebuild with `docker compose build --no-cache learnharness`.
