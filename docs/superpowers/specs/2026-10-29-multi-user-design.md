# LearnHarness multi-user: per-user spaces, admin controls, Storage Box backups

## Context

LearnHarness already runs as a Docker Compose stack (app + Caddy + oauth2-proxy + Keycloak) on home Proxmox VM 104. Today everyone in the Keycloak group `learnharness` shares one data set, one set of settings and one set of API keys (`docs/self-hosting.md:11-13`). The user wants to add other people who each get their own space. They also want an admin account that sets each user's models and caps their spending, and they want to use the Hetzner Storage Box they already have.

Decisions the user made in this session:
- **Host:** stays on home VM 104 with the existing Docker Compose stack. No host move and no Podman migration.
- **Tenancy:** each user's data is separate (chats, graph, documents, learner model, OKF library, preferences). **API keys are shared**: they are the admin's keys, and only the admin manages them.
- **Admin:** sets each user's default models (strong/cheap/vision) and an **allowed list**. Users can switch models only within that list.
- **Spending:** the admin sees per-user usage and sets a **per-user monthly cap**. Over the cap, the user is blocked with a clear message until the next month or until the cap is raised.
- **Storage Box:** for **backups only**. Live data stays on the VM's local disk, with a nightly restic backup to the existing Hetzner Storage Box over SFTP. No S3 or remote primary storage.
- **Existing shared data:** becomes the admin's. Every other user starts empty.
- **Outside access:** WireGuard terminated on VM 104 only, so it gives no access to the LAN. The admin generates peer configs from inside the app.

My calls (flagged so you can veto them):
- The admin is anyone in a new Keycloak group `learnharness-admin`.
- The tenant id is the Keycloak `sub` UUID, so renaming a user or changing their email never orphans their data.
- New users are provisioned automatically on their first request, using the admin's "new user" defaults (default cap and allowed models).
- The monthly window is the calendar month in the server's local time zone (Europe/Berlin).
- Prompt overrides and the OCR cache stay global. The OCR cache is content-addressed, so it is harmless to share.
- I stay with Docker, because the NixOS module is Docker-based. Podman remains possible later; I note the caveats in the docs only.

## Design

### 1. Identity (trust boundary)
- **Caddy** (`deploy/caddy/Caddyfile`):
  - At the top of the site block, strip any client-supplied identity headers with `request_header -X-Auth-Request-*`. The `@pwa` route bypasses `forward_auth`, so without this a client could send its own.
  - Add `X-Auth-Request-Groups` and `X-Auth-Request-Preferred-Username` to `copy_headers`.
- **oauth2-proxy:** verify on the VM which claim fills `X-Auth-Request-User`, and make it `sub`, setting `OAUTH2_PROXY_USER_ID_CLAIM`/`OIDC_*` if needed. Also confirm the groups header format (`learnharness-admin` vs `/learnharness-admin`).
- **Keycloak realm** (`deploy/keycloak/realm-learnharness.json`): add the `learnharness-admin` group. Admins must also be in `learnharness`. Realm import only runs on first start, so the live VM needs a one-time kcadm step.
- **New `src/server/tenant.ts`:**
  - Reads the headers once per request and produces `{ userId, name, isAdmin }`. The userId is sanitised to `[a-z0-9-]`.
  - Requests with no header get 401. In dev and test there is a fallback: `LH_DEV_USER` (default `local`, admin).
  - Exposes `withTenant(req, fn)`, which wraps the handler in an `AsyncLocalStorage` run, and `currentTenant()`.
  - Every `app/api/*` route and every server-component page that reads data goes through it. Pages include `app/page.tsx:14`, `app/chat/[id]/page.tsx:21` and `app/chat/new/page.tsx:26`.

### 2. Per-user data layout
- The new layout is `data/users/<userId>/…`, and each user's directory has **exactly the current data layout**. As a result:
  - the golden fixtures still describe one user's directory (fixture law satisfied without regenerating them, except for the new global files);
  - every store's on-disk format is unchanged.
- **Global** files (`data/global/`):
  - `auth.json`, which stays at `LH_AUTH_FILE`
  - the new `admin.json` (policy)
  - the push VAPID keys
  - prompt overrides
  - `users.json` (the known-user directory: id, name, firstSeen, lastSeen)
- **`config.ts`:**
  - `PATHS`, `LEDGER_FILES`, `SETTINGS_FILE`, `TOPIC_ALIASES_FILE` and the other file constants become getters that resolve against `currentTenant()`. They become functions, not import-time constants.
  - Code outside a tenant context, such as a boot sweep, must pass the userId explicitly. Calling a getter with no tenant throws, so a missing context cannot silently write to a shared location.
- **Module constants to convert:**
  - `src/store/jobs.ts:20`, `src/store/push.ts:17-18` (subscriptions per user, VAPID global)
  - `src/agent/provider-events.ts:39`, `src/store/chats.ts:23`, `src/store/concept-vectors.ts:17`
  - `src/store/documents.ts:18,76`, `src/store/learner.ts:14`, `src/store/okf.ts:17`
  - the ad hoc joins in `src/server/okf.ts:78-94,149`, `src/server/chat-handler.ts:426,443,462`, `src/server/graph.ts:63-70` and `src/server/doc-index.ts:363`
- **Per-user instances** instead of process singletons: `docIndex` (`src/server/doc-index.ts:1136`) and `library` (`src/server/okf-library.ts:20`) become a `Map<userId, instance>`, created lazily.
  - The OKF warm-up at boot moves to first use per user.
  - Doc-index batch resume runs per user at boot, by iterating over `data/users/*` for `pending-batches.json`.
- **Background work:** AsyncLocalStorage carries the tenant through promises and timers, so turns, jobs, extraction and attribution started inside a request inherit it. The remaining cases need explicit handling:
  - The stale-job recovery sweep (`src/server/jobs.ts:657-687`) iterates over all users, each inside a `runAsTenant(id)`.
  - The wake pipeline `pump` (`jobs.ts:418`) and the doc-index timers capture the tenant when they are scheduled.
  - Job records gain `userId`. This is an optional additive field, so no version bump is needed.
- **Process-global registries keyed by chatId or jobId stay as they are**, because the ids are random. These need changes:
  - **Events bus** (`src/core/events.ts`): every event carries `userId`, and `GET /api/events` (`src/server/events-stream.ts`) filters to the caller's userId.
  - **Activity feed and extraction registry** (`/api/activity`, `extraction.ts:816`): filtered by tenant.
  - **Push** (`src/store/push.ts:110`): `notify()` sends only to the owning user's subscriptions.
  - **Graph delete guard** (`src/server/graph.ts:112`): checks only the caller's extractions.
- **LLM semaphore** (`bg-llm-semaphore.ts:38`): stays global, with three slots. I'm noting this as a fairness limit, not fixing it now.

### 3. Shared keys and admin policy
- Keys stay process-wide in `process.env` (`src/server/keys.ts`), so the pi-ai env-key issue does not arise.
  - `/api/keys` routes become **admin-only**.
  - The non-admin Settings view hides the keys section and shows "managed by your admin".
- **New `admin.json`** (global), defined with a new port `AdminStore` in `src/core/ports.ts`, an adapter `src/store/admin.ts` and a contract in `src/core/contracts/admin.ts`:
  ```
  { version, newUserDefaults: { allowedModels: ["provider:id", …], slots: {strong,cheap,vision}, monthlyCapUsd: number|null },
    users: { [userId]: { allowedModels, slots, monthlyCapUsd: number|null, disabled?: boolean } } }
  ```
- **Model resolution** (`src/core/settings-resolution.ts`, `resolveEngine` in `chat-handler.ts:173`):
  - The user's settings slots, per-chat `chat.model` and role overrides are each checked against that user's allowed list.
  - A model outside the list falls back to the admin-assigned slot for that user. The UI shows a note when this happens.
  - `PUT /api/settings` and `PUT /api/chats/[id]/settings` reject models that are not allowed.
  - The model picker (`/api/models` catalog) lists only the allowed models for non-admins.

### 4. Spending caps
- **Spend comes from the request log** that 0.29.0 added (`src/store/request-log.ts`, `data/logs/requests-YYYY-MM.jsonl`, folded by `src/server/usage.ts` `usageMonth()`). The log already covers every LLM call, embeddings, OCR and search. It lives under `PATHS.logs`, so after PR 1 it is per user automatically. The cap check is `usageMonth().total` for the caller's tenant: a read-time fold, nothing dual-tracked. Unpriced lines stay "unpriced", never zero.
- **Enforcement:**
  - `handleChatRequest` checks before each user turn and before ack-and-steer job launches. Over the cap, it returns a typed refusal (like `ModelsNotConfigured`), which the chat UI renders as "Monthly limit reached — ask your admin".
  - Background extraction already queued for an over-cap user is skipped, not run. It catches up after a reset. This is contained and never touches the response.
- If folding the month file per turn proves slow, cache the fold per user, keyed by the month file's size and mtime. This is a cache, not a second source of truth.

### 5. Admin UI
- A new page `app/admin/page.tsx`, with routes `app/api/admin/{users,policy}`. Both are admin-only and return 403 for anyone else.
- The page has a table of users (from `users.json`): name, last seen, this month's spend and unpriced count, cap, and models. Clicking a user opens an editor for:
  - cap (or none)
  - allowed models (multi-select from the catalog)
  - slot defaults
  - disabled flag
- A "New user defaults" panel sets what new users get.
- The page reuses the existing Settings page components and catalog picker. Components import only `@/src/core` (lint law). The page and routes use the `@/src/server` barrel.
- Settings and nav links to Admin appear only for admins.

### 6. Migration of existing data
- A new script, `scripts/migrate-to-tenants.ts --owner <keycloak-sub>`, moves today's `data/*` into `data/users/<sub>/` and global files into `data/global/`. It writes `admin.json` with the owner having no cap and the full allowed list.
- It is idempotent and refuses to run if `data/users/` already exists.
- The image entrypoint does not auto-migrate. Instead, at boot the app **refuses to start** if a legacy layout is present, with a message naming the script, so the data cannot silently move to an unknown owner.

### 7. Backups to the Storage Box (NixOS, `deploy/nixos/`)
- `services.restic.backups.learnharness` on VM 104, repo `sftp:<sub-account>@<storage-box-host>:/learnharness`.
  - It uses a **Storage Box sub-account** confined to its own directory, kept separate from the Pelican backups.
  - The SSH key and restic password live on the VM under `/var/lib/learnharness/` and are generated or placed once, the same way `secrets.env` is today.
- **Contents:**
  - `/var/lib/learnharness/volumes/learnharness` (all user data and `auth.json`)
  - a `pg_dump` of `keycloak-db`, so the user accounts survive a restore
  - `secrets.env`
- **Consistency:** chat writes are non-atomic `writeFileSync` calls, so `backupPrepareCommand` runs `docker compose pause learnharness` (and `docker compose exec keycloak-db pg_dump …` to a file), and `backupCleanupCommand` unpauses. The pause lasts only for the snapshot, a few seconds for this data size.
- **Schedule:** 04:00 nightly, prune keep-daily 7 / weekly 4 / monthly 6, matching the Pelican policy.
- A restore runbook is added to `docs/self-hosting.md`.
- **Credential steps that are yours:**
  - create the Storage Box sub-account (Hetzner console or `~/hetzner` tofu)
  - authorize the VM's public key on it
  - store the restic password in your password store. Losing it makes the repo unrecoverable.

### 8. Access from outside: WireGuard on VM 104 only, with peers managed from the admin page
This is the user's choice. The tunnel ends **on the VM**, not on the FRITZ!Box, so a peer can reach only LearnHarness. Keycloak login still applies on top. I picked QR codes and the host-side applier below as the approach.

- **Host (NixOS, `deploy/nixos/`):**
  - `networking.wireguard.interfaces.wg0` on `10.66.0.1/24`, listening on UDP 51820. Open 51820/udp in `networking.firewall`.
  - The server private key is generated on first boot into `/var/lib/learnharness/wg/` and never enters the container. The public key and endpoint reach the app as env vars: `WG_SERVER_PUBLIC_KEY`, `WG_ENDPOINT`, `WG_ALLOWED_IPS`.
  - **Clients use the same hostnames as today.** Peer `AllowedIPs` is the VM's LAN IP `/32` (`WG_ALLOWED_IPS`). The public DNS for `learnharness.home.moyjak.com`/`auth.home.moyjak.com` already points there, so OIDC redirects, cookies and certificates are unchanged. Traffic to the VM's own address over wg0 is local INPUT, not forwarding.
    - **Move day** (LAN IP changes to `10.20.1.70`): existing peers must re-download their config. The admin page shows a "configs outdated" badge when the stored `allowedIps` no longer matches the env.
  - **Endpoint:** a Cloudflare DDNS record `vpn.moyjak.com`, updated by a small systemd timer on the VM using the existing CF token in `secrets.env`, or the MyFRITZ name if you prefer.
    - **Pre-check (blocking):** the FRITZ!Box WAN must have a public IPv4. On DS-Lite, inbound v4 is impossible, and the endpoint falls back to an AAAA record for the VM's global IPv6 plus an IPv6 port opening on the FRITZ!Box.
  - **FRITZ!Box** (your step): a port share of UDP 51820 to VM 104.
- **Isolation (nftables on the VM):**
  - wg0 is allowed INPUT only on tcp 80/443 (Caddy). There is no forwarding from wg0 anywhere (`forward` drop for `iifname wg0`).
  - **Egress from the VM and its Docker containers to the LAN is dropped**: RFC1918 and the LAN's IPv6 ULA/GUA prefix, with exceptions for the gateway's DNS/NTP and for established and related traffic, so SSH from your WSL into the VM still works. The container rules go in `DOCKER-USER`.
  - **Access from home is unchanged.** Any LAN device opens `https://learnharness.home.moyjak.com` (80/443) and `auth.home.moyjak.com` directly, with no tunnel, and `ssh root@learnharness.fritz.box` (22) keeps working, as do 8443 and deploys from WSL.
    - The isolation is one-way: it only stops the VM and its containers from **opening** connections into the LAN. Replies to connections that LAN devices open are allowed (`ct state established,related accept`).
    - WireGuard is needed only away from home. On phones, the WireGuard app's on-demand rule (iOS), or just switching the tunnel off, keeps home Wi-Fi on the direct path.
  - The verification below checks LAN access to 80/443/22 explicitly after the firewall change.
- **Peer management in the app** (admin only; the app never executes anything on the host):
  - `/admin` gains a "Devices (WireGuard)" section: for a given user, name a device, then click **Create**.
  - The server generates an X25519 keypair with Node `crypto.generateKeyPairSync("x25519")` (raw 32-byte keys, base64) and a preshared key. It assigns the next free IP in `10.66.0.0/24`.
  - The client config (`[Interface] PrivateKey/Address`, `[Peer] PublicKey/PresharedKey/Endpoint/AllowedIPs/PersistentKeepalive=25`) is shown **once** as a QR code (new dependency `qrcode`, rendered as SVG) plus a `.conf` download. The private key is never persisted.
  - `data/global/wireguard-peers.json` (new `WireGuardPeerStore` port and adapter, temp-and-rename write) records `{id, userId, name, publicKey, presharedKey, ip, createdAt, revokedAt?}`. Revoke sets `revokedAt`.
    - The preshared key must persist for the host to apply it. It sits in the global volume next to `auth.json`, which is no worse than the API keys.
  - **Host applier:** a systemd `path` unit watches that file. On each change, a root script:
    - validates every entry (44-character base64 keys, IP inside `10.66.0.0/24`, unique);
    - builds a peers-only config and runs `wg syncconf wg0`;
    - logs and skips invalid entries.
    The container's only influence is a JSON file of public keys, so a compromised app cannot reconfigure the host beyond adding peers.
  - The admin page shows each peer's last handshake. The applier writes `wg show wg0 dump` to `data/global/wireguard-status.json`, which the app reads.
- Disabling a user (`admin.json` `disabled`) also revokes their peers.

### 9. Addendum (2026-10-29, after PR 1 shipped): user creation and WireGuard first
User decisions:
- The next PR builds **user creation and WireGuard devices**. Models and caps come after.
- New users get a **generated temporary password**, shown to the admin once. Keycloak forces a change at first login (`UPDATE_PASSWORD`).

My calls (vetoable):
- **Admin UI location.** The admin features are an admin-only **"Users" section in the existing Settings dialog**, not a separate `/admin` page. That matches the app's UI. The section appears only when `/api/me` says `isAdmin`. Models and caps join it later.
- **Keycloak access from the app.** The app uses a dedicated confidential client `learnharness-admin-api`. Its service account has only the `realm-management` roles `view-users`, `query-users`, `query-groups` and `manage-users`; master-admin credentials never reach the app. The secret `KC_ADMIN_API_SECRET` lives in `secrets.env` (generated by the NixOS stack script) and goes to the app through compose.
  - The stack script ensures the client, roles, secret and the `learnharness-admin` group idempotently on every start, using `kcadm` inside the Keycloak container.
  - Without the secret, the Users section shows "user management is not configured".
- **What an admin can do:**
  - list the users
  - create a user (username, optional email, admin yes/no), who is placed in `learnharness` (+ `learnharness-admin`)
  - toggle admin
  - manage WireGuard devices per user
- **What is left out:** an admin can never remove their own admin flag. Deleting or disabling users comes later.
- **WireGuard host ↔ app contract.** Everything goes through files in the shared data volume (`data/global/wireguard/`). The app never runs anything on the host.
  - `server.json` is written by the host and read by the app: `{publicKey, endpoint, allowedIps}`. `allowedIps` is the VM's current LAN IPv4 `/32`, read from the default route, so move day updates it by itself.
  - `peers.json` is written by the app with temp-file-then-rename and read by the host applier.
  - `status.json` is written by the host every minute and after each apply. It is the parsed `wg show wg0 dump`: the last handshake per public key.
- **Endpoint.** `vpn.moyjak.com:51820` is an A record kept current by a 5-minute DDNS timer on the VM, using `CLOUDFLARE_API_TOKEN` from `secrets.env`. The record is created by the script, not by OpenTofu. Verified 2026-10-29: the FRITZ!Box WAN has a public IPv4 (no DS-Lite).
- **Client config:** `AllowedIPs = <VM LAN IP>/32`, no `DNS` line, `PersistentKeepalive = 25`. The existing public names resolve to the LAN IP, so the browser goes through the tunnel and OIDC is unchanged.

## Delivery (PRs, each through the normal release flow: bump in PR, merge, tag, deploy)
1. **Tenant context + per-user paths.** `tenant.ts`, ALS, `config.ts` getters, store and module-constant conversion, per-user `docIndex`/`library`, background sweeps, event/activity/push filtering, migration script and boot guard, Caddy and oauth2-proxy header changes, and docs: `docs/architecture.md` (new "Tenancy" section, fix the stale PracticeStore line) and `docs/self-hosting.md` §"one shared data set".
2. **Admin policy + models.** `AdminStore`, `admin.json`, admin-only keys, the allowed-list resolution, and the `/admin` page (users and models).
3. **Spending caps.** Derived month spend, the cap refusal in the turn and job paths, the usage columns in admin, and the chat refusal UI.
4. **Backups.** The NixOS restic module, the pg_dump hook and the restore runbook.
5. **WireGuard + LAN isolation.** NixOS wg0, nftables isolation, DDNS timer and peer applier, the `WireGuardPeerStore` and admin "Devices" UI, and the `docs/self-hosting.md` section on remote access.

Before step 1, the design also goes into `docs/superpowers/specs/2026-10-29-multi-user-design.md` (committed with PR 1). Implementation follows `superpowers:writing-plans` and subagent-driven development in worktrees.

**Deploy order on the VM:**
1. Add the `learnharness-admin` group and put yourself in it.
2. Verify the header claims.
3. Merge PR 1, stop the stack, and run the migration script with your `sub`.
4. Restart the stack.

## Verification
- **Gates per PR:** `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`, and the standalone smoke scripts.
- **New tests**, kept to the simplest form that proves each behaviour:
  - Two tenants (`runAsTenant("a")`/`("b")`) using an isolated `LH_DATA_DIR`. A chat, graph write, document import and job in A are invisible to B. The events stream for B receives none of A's events.
  - A request without the identity header gets 401. A non-admin gets 403 on `/api/admin/*` and `/api/keys`.
  - Model resolution: a disallowed `chat.model` falls back to the admin slot, and `PUT /api/settings` rejects disallowed models.
  - Spend derivation: priced turns, extraction runs and jobs across a month boundary. Over the cap, a turn gets the typed refusal. Unpriced calls stay absent.
  - Migration script: a legacy fixture dir becomes `users/<owner>/` byte-identical. A second run refuses. The app refuses to boot on a legacy layout.
  - `tests/golden-fixtures.test.ts` still passes against a per-user dir.
- **Docker end-to-end:**
  - Bring up `deploy/compose.yaml` locally with two Keycloak users, one of them admin.
  - Log in as each with puppeteer and Chromium. Confirm separate graphs and chats, that the admin page is visible only to the admin, and the cap message after setting a $0.01 cap.
  - Confirm that a spoofed `X-Auth-Request-User` sent to `/manifest.webmanifest` and `/api/*` is stripped.
- **WireGuard:**
  - Unit test: a generated config parses, the public key derives from the private key, and IP allocation skips used and revoked addresses. The applier script rejects malformed entries (shell test in the NixOS check).
  - On the VM, create a peer from `/admin`, scan the QR on the phone over mobile data, and confirm the app loads after the Keycloak login.
  - From the phone, confirm that `192.168.178.1` (the FRITZ!Box UI) and other LAN hosts are unreachable.
  - From the VM (and from inside the `learnharness` container), confirm that `curl` to a LAN host fails while the LLM providers work.
  - Revoke the peer and confirm its handshake stops.
  - After the firewall change, from a LAN device with no tunnel: the app loads at `https://learnharness.home.moyjak.com` (and `http://` redirects), `ssh root@learnharness.fritz.box` works, and `systemctl restart learnharness-stack` over SSH still deploys.
- **VM:** after the deploy, run `systemctl start restic-backups-learnharness`, then `restic snapshots` and a test `restic restore` into a scratch directory.
