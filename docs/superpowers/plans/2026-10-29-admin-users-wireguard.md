# Admin: Users and WireGuard Devices — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can create Keycloak users and hand each person WireGuard configs (QR code) from the app. The VM terminates WireGuard, can't reach the LAN, and is still reachable directly from the LAN.

**Architecture:**
- The app talks to Keycloak's admin REST API through a narrowly scoped confidential client.
- WireGuard is split at a file boundary in the shared data volume. The app writes `peers.json`. A root applier on the NixOS host validates it and runs `wg syncconf`. The host writes `server.json` and `status.json` for the app to read.
- The UI is an admin-only "Users" section in the Settings dialog.

**Tech Stack:** Next.js 16 route handlers, node:crypto X25519, `qrcode` (SVG), NixOS (`networking.wireguard`, systemd path and timer units, iptables via `networking.firewall.extraCommands`), Python 3 for the host applier (stdlib only).

**Spec:** `docs/superpowers/specs/2026-10-29-multi-user-design.md`, §8 and §9 (addendum). §9 wins where they differ.

## Global Constraints
- **Admin gating.** Every new route uses `withTenant` and calls `requireAdmin()` first (`src/server/tenant.ts`). Every response to non-admins is `403 {error:"admin_only"}`.
- **Keycloak.**
  - Realm `learnharness`. Groups `learnharness` (every user) and `learnharness-admin`.
  - Admin API client id: `learnharness-admin-api`. Env: `KC_ADMIN_API_URL` (compose: `http://keycloak:8080`) and `KC_ADMIN_API_SECRET`.
  - If either env var is missing, the user routes answer `503 {error:"user_admin_not_configured"}`.
- **New users** get a generated password of 20 chars from `[A-Za-z0-9]`, made with `crypto.randomInt`. The password is `temporary: true` with `requiredActions: ["UPDATE_PASSWORD"]`. It is returned once in the create response and never stored or logged.
- **Self-protection.** An admin cannot remove their own admin flag. That request gets `409 {error:"self_demotion"}`.
- **WireGuard values:**
  - Subnet `10.66.0.0/24`. The server is `10.66.0.1`. Peers get `10.66.0.2`–`10.66.0.254`. The lowest free address is assigned, and an address held by any peer, revoked or not, is never reused.
  - Port `51820/udp`. Endpoint `vpn.moyjak.com:51820`. `PersistentKeepalive = 25`.
- **Files** live in `<globalDataRoot()>/wireguard/`:
  - `server.json` `{publicKey, endpoint, allowedIps}`, written by the host.
  - `peers.json` `{version:1, peers:[{id, userId, name, publicKey, presharedKey, ip, createdAt, revokedAt?}]}`, written by the app with temp-file-then-rename at mode 0600.
  - `status.json` `{updatedAt, peers:{[publicKey]:{latestHandshake:number|null, endpoint:string|null}}}`, written by the host.
- **Client private keys** are never persisted or logged. They appear only in the create response's `config` and `qrSvg`.
- **Import law:** `app/` imports only the `@/src/core` and `@/src/server` barrels. `components/` imports only `@/src/core`. New stores go behind a port in `src/core/ports.ts`.
- **LAN access stays direct.** LAN devices keep 22, 80, 443 and 8443 inbound. The isolation only blocks connections the VM or its containers open into RFC1918 space, plus wg0 forwarding.
- **Version:** `0.32.0`.

## Review Focus
1. **Keycloak bootstrap on an existing install** (Task 4). The client and group may already exist, and the secret in `secrets.env` must match the client. The bootstrap must be idempotent and must not fail the stack start when Keycloak is slow: retry, then log and continue. Owner: Task 4. Pin it with a shellcheck-clean script and a comment noting it was verified on the VM.
2. **A malicious or broken `peers.json`** (Task 4 applier): bad base64, IP outside the subnet, duplicate IPs, extra `[Interface]` text injected through `name`. The applier must skip bad entries and never write a field it did not validate. `name` never reaches the wg config. Owner: Task 4 Python tests.
3. **Concurrent device creation** (Task 2). Two creates in a row must get different IPs. Read-modify-write is synchronous within one process, so assert sequential uniqueness. Owner: Task 2.
4. **Firewall lockout.** A rule mistake could cut SSH from the LAN. Deployment (Task 5) uses `nixos-rebuild test` first and checks a fresh SSH connection before `switch`. Owner: Task 5.
5. **`server.json` missing** (host side not deployed yet). Device creation answers `503 {error:"wireguard_not_ready"}` and the UI says so. Owner: Task 2 test.

---

### Task 1: Keycloak admin client and user routes

**Files:**
- Create: `src/server/keycloak-admin.ts`
- Create: `app/api/admin/users/route.ts` (GET list, POST create)
- Create: `app/api/admin/users/[id]/admin/route.ts` (PUT `{admin:boolean}`)
- Modify: `src/server/index.ts` (barrel), `deploy/compose.yaml` (app env `KC_ADMIN_API_URL: http://keycloak:8080` and `KC_ADMIN_API_SECRET: ${KC_ADMIN_API_SECRET:-}`)
- Test: `tests/admin-users.test.ts`

**Interfaces:**
- Produces:
  - `interface AdminUser { id: string; username: string; email: string | null; isAdmin: boolean; enabled: boolean; createdAt: number | null }`
  - `createKeycloakAdmin(opts: { baseUrl: string; secret: string; fetch?: typeof fetch }): KeycloakAdmin`, where:
    - `listUsers(): Promise<AdminUser[]>` — up to 500, sorted by username.
    - `createUser(input: { username: string; email?: string; admin: boolean }): Promise<{ user: AdminUser; temporaryPassword: string }>`
    - `setAdmin(userId: string, admin: boolean): Promise<void>`
  - `keycloakAdmin(): KeycloakAdmin | null`, built from the env, or null when not configured.
- How it works:
  - Get a token with `client_credentials` at `{baseUrl}/realms/learnharness/protocol/openid-connect/token`. Cache it until 30 s before `expires_in`.
  - Read admin membership from `GET /admin/realms/learnharness/groups/{id}/members?briefRepresentation=true&max=500`. Look the group id up by `GET .../groups?search=learnharness-admin&exact=true`.
  - Create with `POST /admin/realms/learnharness/users` and the body `{username, email, enabled:true, emailVerified:false, requiredActions:["UPDATE_PASSWORD"], credentials:[{type:"password", value, temporary:true}], groups:["/learnharness", ...(admin?["/learnharness-admin"]:[])]}`. Read the new id from the `Location` header.
  - Admin toggle: `PUT` or `DELETE /admin/realms/learnharness/users/{id}/groups/{gid}`.
- Route validation and errors:
  - Username must match `^[a-z0-9][a-z0-9._-]{1,31}$`; otherwise `400 {error:"invalid_username"}`.
  - Email is optional and must contain `@`.
  - A Keycloak 409 becomes `409 {error:"username_taken"}`.

- [ ] **Step 1: Write the failing tests.**
  - Stub `globalThis.fetch` with a small fake Keycloak: a Map of users, the group membership, and the token endpoint.
  - Assert:
    - (a) `GET /api/admin/users` as a non-admin → 403.
    - (b) As an admin → `200 {users:[…]}` with `isAdmin` derived from membership.
    - (c) POST `{username:"anna"}` → 201 `{user, temporaryPassword}`. The password has length 20 and matches `/^[A-Za-z0-9]{20}$/`. The fake received `temporary:true`, `UPDATE_PASSWORD` and `groups` containing `/learnharness`.
    - (d) POST with `"Anna!"` → 400 `invalid_username`.
    - (e) A duplicate → 409 `username_taken`.
    - (f) PUT admin false on yourself → 409 `self_demotion`. On another user → 204, and the fake's membership changed.
    - (g) No `KC_ADMIN_API_SECRET` → 503 `user_admin_not_configured`.
  - Use `LH_MULTI_USER=1` and identity headers, following the pattern in `tests/tenancy-failclosed.test.ts`.
- [ ] **Step 2:** Run `NODE_ENV=test npx tsx --test tests/admin-users.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the test, `npm test` and `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(admin): Keycloak user listing, creation, admin toggle`.

### Task 2: WireGuard devices (app side)

**Files:**
- Modify: `src/core/ports.ts` (add `WireGuardStore`)
- Create: `src/core/contracts/wireguard.ts` (types plus pure helpers, browser-safe)
- Create: `src/store/wireguard.ts` (adapter, wired in `src/server/stores.ts`)
- Create: `src/server/wireguard.ts`
- Create: `app/api/admin/devices/route.ts` (GET `?userId=`, POST `{userId, name}`)
- Create: `app/api/admin/devices/[id]/route.ts` (DELETE = revoke)
- Modify: `package.json` (add `qrcode` and `@types/qrcode`)
- Test: `tests/wireguard.test.ts`

**Interfaces:**
- Produces (contracts):
  - `WgPeer`, `WgServerInfo`, `WgStatus`, matching the Global Constraints shapes.
  - `nextFreeIp(peers: WgPeer[]): string | null`
  - `clientConfig(p: { privateKey: string; address: string; serverPublicKey: string; presharedKey: string; endpoint: string; allowedIps: string }): string` — exactly these lines:
    ```
    [Interface]
    PrivateKey = …
    Address = <ip>/32

    [Peer]
    PublicKey = …
    PresharedKey = …
    Endpoint = …
    AllowedIPs = …
    PersistentKeepalive = 25
    ```
- Produces (port `WireGuardStore`): `readServer(): WgServerInfo | null`, `readPeers(): WgPeer[]`, `writePeers(peers: WgPeer[]): void`, `readStatus(): WgStatus | null`.
- Produces (server):
  - `listDevices(userId?: string): Array<WgPeer & { latestHandshake: number | null; stale: boolean }>`, with `presharedKey` stripped from the output. `stale` means a non-revoked peer that was created while `server.allowedIps` differed: store `allowedIps` on the peer at creation.
  - `createDevice(userId: string, name: string): Promise<{ device; config: string; qrSvg: string }>`, which throws `WireGuardNotReady` when `readServer()` is null.
  - `revokeDevice(id: string): boolean`.
  - Keys:
    - Generate with `crypto.generateKeyPairSync("x25519")`.
    - Export raw 32-byte keys as base64. `publicKey.export({format:"jwk"}).x` is base64url, so convert it to standard base64. Do the same for `d` (the private key).
    - The preshared key is `crypto.randomBytes(32).toString("base64")`.
- Wire shapes: `GET /api/admin/devices?userId=` returns `{devices}`. `POST` returns `201 {device, config, qrSvg}`. `DELETE` returns `204`, or `404 {error:"not_found"}`. (Users, Task 1: `GET` returns `{users}`, and `POST` returns `201 {user, temporaryPassword}`.)
- Validation: `name` is 1–40 chars from `[A-Za-z0-9 ._-]`, else 400 `invalid_name`. `userId` must match `TENANT_ID_RE`.

- [ ] **Step 1: Write the failing tests.**
  - (a) A generated keypair's public key, derived again from the private key with `crypto.createPrivateKey({key: {kty:"OKP", crv:"X25519", d, x}, format:"jwk"})` → `createPublicKey`, matches the public key.
  - (b) `nextFreeIp` skips used and revoked addresses and returns null when all 253 are taken.
  - (c) Two sequential `createDevice` calls get different IPs.
  - (d) `clientConfig` output parses into the expected key/value pairs and contains no `name`.
  - (e) `peers.json` on disk has no private key, and the file mode is 0600.
  - (f) POST without `server.json` → 503 `wireguard_not_ready`.
  - (g) Revoke sets `revokedAt` and keeps the entry. `listDevices` joins `latestHandshake` from `status.json`.
  - (h) A non-admin gets 403 on the device routes.
  - (i) The QR SVG starts with `<svg`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the test, `npm test`, `typecheck` and `lint` → PASS.
- [ ] **Step 5:** Commit `feat(admin): WireGuard device configs with QR`.

### Task 3: "Users" section in Settings (admin-only UI)

**Files:**
- Create: `components/settings/users-section.tsx`
- Modify: `components/settings/settings-dialog.tsx` (append `{ id: "users", label: "Users" }`, shown only when `/api/me` returns `isAdmin`)
- Test: `tests/render-users-section.test.tsx` (`renderToStaticMarkup`, no DOM)

**Behaviour:**
- **User list:** username, email, an "admin" badge and a device count. A user can be expanded to show:
  - their devices (name, IP, "last seen" from `latestHandshake` or "never", and an "outdated — re-create" badge when `stale`);
  - an **Add device** form (name);
  - **Revoke** on each device;
  - **Make admin / Remove admin** (disabled for yourself).
- **Add user** form: username, email (optional), an admin checkbox. On success, a one-time panel shows:
  - "Temporary password for <username>: <pw>" with a Copy button;
  - "They'll set their own password at first login. This password is not shown again.";
  - and it tells the admin to share the login URL `https://<current host>/`.
- **Add device** success: a one-time panel shows the QR (`dangerouslySetInnerHTML` with the server SVG, which comes from our own `qrcode` output), a **Download .conf** link (a blob of `config`, file name `<username>-<device>.conf`), and this note: "Scan with the WireGuard app. The private key is not stored — if lost, revoke and create a new device."
- **Errors** render inline:
  - `user_admin_not_configured` → "User management isn't set up on this server yet."
  - `wireguard_not_ready` → "WireGuard isn't set up on this server yet."
- **Presentational split:** export a pure `UsersSectionView` that takes props (users, devices, pending states, callbacks) so render tests need no fetch. The stateful `UsersSection` wraps it.

- [ ] **Step 1: Write the failing render tests.**
  - The view with 2 users (one admin, one with a stale device) shows the admin badge, "outdated", "never", and a disabled self-demotion button.
  - The temp-password panel renders the password and the "not shown again" text.
  - The device panel renders the svg and the download link with the right filename.
  - The not-configured message renders.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run the test, `npm test`, `typecheck`, `lint` and `build` → PASS.
- [ ] **Step 5:** Commit `feat(admin): Users section — create users, devices with QR`.

### Task 4: NixOS host — Keycloak bootstrap, wg0, applier, DDNS, isolation

**Files:**
- Modify: `deploy/nixos/learnharness-stack.nix`
  - Generate `KC_ADMIN_API_SECRET` once in `secrets.env`, using the same pattern as `OCR_TOKEN`.
  - After `compose up`, run `bootstrap-keycloak.sh`, with up to 3 minutes of retries. On failure, log `keycloak bootstrap failed` and continue.
- Create: `deploy/nixos/bootstrap-keycloak.sh`
  - It runs `docker exec learnharness-keycloak-1 /opt/keycloak/bin/kcadm.sh …` with `--config /tmp/kcadm-bootstrap` and removes that file at the end.
  - It ensures:
    - the group `learnharness-admin`;
    - the client `learnharness-admin-api` (confidential, `serviceAccountsEnabled=true`, `standardFlowEnabled=false`, `directAccessGrantsEnabled=false`), with its secret set to `$KC_ADMIN_API_SECRET`;
    - the service account user `service-account-learnharness-admin-api` holding the `realm-management` client roles `view-users`, `query-users`, `query-groups` and `manage-users` (via `add-roles --cclientid realm-management`).
  - Every step is idempotent: a get before each create.
- Create: `deploy/nixos/wireguard.nix` (imported in `flake.nix` modules). Options: `services.learnharness.wireguard.{enable, endpoint ? "vpn.moyjak.com", port ? 51820, ddnsName ? "vpn.moyjak.com", ddnsZone ? "moyjak.com"}`, enabled in `configuration.nix`.
  - **Interface:**
    - `networking.wireguard.interfaces.wg0`: `ips = ["10.66.0.1/24"]`, `listenPort = 51820`, `privateKeyFile = "/var/lib/learnharness/wg/private"`, `generatePrivateKeyFile = true`, and no static peers.
    - `networking.firewall.allowedUDPPorts = [ 51820 ]`.
  - **Applier:** `systemd.services.learnharness-wg-apply` (oneshot, root) runs `python3 ${./wg-apply.py}` with the data dir `/var/lib/learnharness/volumes/learnharness/data/global/wireguard` and the wg private key path. `systemd.paths.learnharness-wg-apply` triggers it with `PathChanged=` on `peers.json`. `systemd.timers.learnharness-wg-status` triggers it every minute with `--status-only`.
  - **DDNS:** `systemd.services.learnharness-ddns` and a timer that runs every 5 minutes. It reads `CLOUDFLARE_API_TOKEN` from `secrets.env`, finds the zone id by name, and upserts an A record `vpn.moyjak.com` (`proxied:false`, ttl 300) to `curl -4 https://api.ipify.org`. It does nothing when the record is unchanged.
  - **Isolation:** `networking.firewall.extraCommands`, plus matching `extraStopCommands` deletes. All rules are inserted, idempotent, and commented:
    - INPUT from wg0: allow tcp 80/443 only. Insert at the top of `nixos-fw`: `-i wg0 -p tcp -m multiport --dports 80,443 -j nixos-fw-accept`, then `-i wg0 -j nixos-fw-refuse`. The wg0 address 10.66.0.1 must not get SSH.
    - Docker-published ports reached from wg0, in `DOCKER-USER` (create the chain if missing):
      - `-i wg0 -o <lan-if>` → DROP (no forwarding into the LAN);
      - `-i wg0 -p tcp -m conntrack --ctorigdstport` not 80/443 → DROP.
    - Egress to the LAN, from the host (OUTPUT) and from containers (DOCKER-USER, `-i docker+ / br-+`):
      - established/related → ACCEPT;
      - the gateway `192.168.178.1` udp/tcp 53 and udp 123 → ACCEPT;
      - `-d 192.168.0.0/16`, `-d 10.0.0.0/8` except `10.66.0.0/24`, `-d 172.16.0.0/12` (host OUTPUT only, NOT container-to-container), all with ctstate NEW → REJECT.
    - Make the LAN gateway an option: `services.learnharness.wireguard.lanGateway ? "192.168.178.1"`.
  - **`server.json`:** the applier writes it on every run (0644), with:
    - `publicKey` from `wg pubkey < private`;
    - `endpoint` = `"${endpoint}:${port}"`;
    - `allowedIps` = the IPv4 of the default-route interface + `/32`.
- Create: `deploy/nixos/wg-apply.py` (stdlib only):
  - Reads `peers.json` and validates each entry: base64 decodes to 32 bytes for `publicKey` and `presharedKey`; `ip` is inside `10.66.0.0/24` and not `.0`, `.1` or `.255`; IP and key are unique; `revokedAt` absent.
  - Writes the conf: `[Interface] PrivateKey=<file contents> ListenPort=51820`, then per valid peer `[Peer] PublicKey, PresharedKey, AllowedIPs = <ip>/32`. `name` is never written.
  - Runs `wg syncconf wg0 <tmpfile>` and writes `status.json` from `wg show wg0 dump`.
  - Flags:
    - `--dry-run`: print the conf to stdout, skip `wg`.
    - `--status-only`.
- Test: `tests/deploy/test_wg_apply.py` (unittest, `python3 -I -B -m unittest discover -s tests/deploy -v`)
  - Feeds a temp `peers.json` with:
    - one valid peer;
    - a bad key;
    - an out-of-subnet IP;
    - a duplicate IP;
    - a revoked peer;
    - a `name` containing `"\n[Interface]\nPrivateKey = x"`.
  - Asserts that `--dry-run` output contains exactly one `[Peer]` and never the injected text.
- Modify: `docs/self-hosting.md` — a new "## Remote access (WireGuard)" section covering:
  - what it exposes (only the app);
  - the FRITZ!Box step: Internet → Freigaben → Portfreigabe → the learnharness device → UDP 51820 → 51820, IPv4;
  - creating devices in Settings → Users;
  - home Wi-Fi: turn the tunnel off, or use on-demand on iOS;
  - move day: re-create devices marked "outdated";
  - and the "Users" section (creating users).
- Verification: `nix build ./deploy/nixos#nixosConfigurations.learnharness.config.system.build.toplevel --no-link` succeeds (WSL has nix with kvm). `shellcheck deploy/nixos/bootstrap-keycloak.sh` is clean if shellcheck is available (use `nix run nixpkgs#shellcheck`).

- [ ] **Step 1:** Write `tests/deploy/test_wg_apply.py`, then run it → FAIL (the script is missing).
- [ ] **Step 2:** Implement `wg-apply.py`, then run → PASS.
- [ ] **Step 3:** Write the Nix modules, the bootstrap script and the docs. Run the `nix build` toplevel and shellcheck.
- [ ] **Step 4:** Bump the version to 0.32.0. Run the full gate line: `npm run typecheck && npm test && npm run lint && npm run build && node scripts/smoke-provider-runtime.mjs && node scripts/build-server.mjs && node scripts/smoke-server.mjs`.
- [ ] **Step 5:** Commit `feat(deploy): WireGuard on the VM, LAN isolation, DDNS, Keycloak admin client bootstrap`.

### Task 5: Deploy and verify (controller only, not a subagent)
1. Merge the PR. Then `nixos-rebuild test --flake ./deploy/nixos#learnharness --target-host root@learnharness.fritz.box`.
2. Open a fresh SSH session from WSL; it must succeed. Then run `nixos-rebuild switch …`.
3. Run `systemctl restart learnharness-stack`. Then check:
   - the bootstrap log;
   - `server.json` exists;
   - `wg show wg0`;
   - the DDNS record resolves.
4. From the LAN, `curl -sI https://learnharness.home.moyjak.com` returns 302 (login). On the VM, `curl --max-time 3 http://192.168.178.1` fails while `curl https://api.ipify.org` works. Both checks also run from inside the app container.
5. As admin, use the UI to create a test user and a device, then revoke them.
6. User steps:
   - the FRITZ!Box port forward;
   - scan the QR on the phone with mobile data;
   - the app loads after login;
   - `http://192.168.178.1` is unreachable from the phone.
7. Tag v0.32.0 and publish the release.
