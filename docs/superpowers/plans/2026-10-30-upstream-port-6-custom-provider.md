# Upstream Port 6: Custom OpenAI-Compatible Provider (Admin-Managed) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin can connect one OpenAI-compatible endpoint: a LAN Ollama or LM Studio, or a paid remote API. Its models then become selectable like any other provider's. The connection is priced honestly, so spending caps keep working.

**Architecture:** Port upstream's final custom-endpoint shape (b488213 and the follow-ups) with four changes for the fork's multi-user design:
1. **Global configuration.** The connection is one instance-wide record, `<globalDataRoot()>/custom-provider.json`, behind a new port. It is never per-tenant settings. The key lives in the global `LH_AUTH_FILE`, using upstream's binding entry.
2. **Admin-only changes.** Every mutation calls `requireAdmin()`.
3. **Pricing.** The endpoint is either `free` (local) or `paid`, and paid models carry admin-entered per-model rates. Restricted users with a cap are never offered a paid custom model that has no rates.
4. **Gate order.** In `piEngineForSpec`, the model gate runs first, then upstream's custom revalidation and image clone.

**Tech Stack:** Next.js 16, TypeScript, pi-ai `openai-completions`, node:test, NixOS iptables.

**Spec:** group M of the owner-approved evaluation, which lives outside the repo; read it, never commit it. Read upstream's final files at `dc4c398` (`git show dc4c398:<path>`):
- `src/server/custom-provider*.ts`
- `src/core/custom-provider-auth.ts`
- `app/api/custom-provider/route.ts`
- `src/store/auth.ts`
- `src/agent/models.ts`
- `docs/custom-providers.md`
- the `tests/custom-provider-*.ts` files

Relevant commits: 07b6403, 870a1ad, dbf8080, 5b1fd81, 1b01919, 286a95b, 6959482, b4a13f5, ef37c26, b488213, 313a3c8, 6158723, ee66a4b. **Skip f69fa35**, which reserves the Claude Code namespace; that work is deferred.

## Global Constraints
- **One global endpoint.** Its config lives in `<globalDataRoot()>/custom-provider.json`, written temp-then-rename at mode 0600, and is never read from tenant settings. The config shape:
  - `{version:1, baseUrl, mode: "keyless"|"key", pricing: "free"|"paid", manualModels?: string[], models?: {[id]: {context?: number, maxOutput?: number, reasoning?: boolean, inputUsdPerMTok?: number, outputUsdPerMTok?: number}}}`
  - A corrupt file reads as "not configured". Writes refuse and leave the file unchanged, the same rule as `admin.json` and `peers.json`.
- **Probe rules, verbatim from upstream:**
  - `GET <base>/models`, with a 15 s timeout, an 8 MiB / 10k-model cap and no redirects. 401 and 403 always fail.
  - A failed probe on the same URL keeps the previous snapshot and pins.
  - Fallbacks: context 8192, max output 4096.
- **The key is bound** to URL, mode and a nonce, so it is never sent to a different URL without the admin re-entering it.
- **Model keys are `custom:<modelId>`.** Model ids may contain `:` (Ollama `qwen3:8b`), so every provider:id split must use the FIRST colon only. Audit `splitQualified`, `modelKey`, the policy parse and the request-log model field.
- **Pricing:**
  - `free` → every custom call is priced at $0 and logged as priced (`providerCostUsd: 0`), not as unpriced. This is the one sanctioned real zero, because local compute costs nothing.
  - `paid` → calls are priced from the per-model rates. A paid model without rates is **unpriced**, and it is excluded from the allowed set of any restricted user who has a non-null cap. That exclusion goes into the gate, the catalog filter and the Users-editor validation.
- **Mutations are admin-only** (`requireAdmin()` → 403 `admin_only`): connect, edit, disconnect, pins, rates and the key.
- Non-admins see custom models only through their allow-list. A missing endpoint shows them "ask your admin" copy.
- **Redaction:** custom credentials are fully redacted in `/api/keys` and every API response (6158723).
- **LAN reachability** is a NixOS option, `services.learnharness.wireguard.lanAllow = [ "<ip>:<port>" ... ]`. It adds RETURN rules before the LAN rejects, in both the host and the container egress chains. **The app can never open LAN access by itself.**
- **PUBLIC REPOSITORY:** no real ids, hosts, IPs or emails. Use `192.0.2.x` / `example.com` in tests and docs.
- **Version:** `0.39.0`.

## Review Focus
1. **Cross-tenant leakage.** No code path reads custom-provider config from tenant settings, and `piModels()` syncs from the global record only.
2. **Ollama-style ids.** `custom:qwen3:8b` round-trips through the policy (`allowedModels`), the request log, the usage fold and `prettyModel`.
3. **Cap bypass.** A capped restricted user can never run a paid custom model without rates: no gate pass, not in the catalog, refused by the editor.
4. **Key redirection.** Changing the base URL never sends the old key to the new URL.
5. **Firewall.** `lanAllow` opens exactly the listed `ip:port`, and nothing else in the LAN.

---

### Task 1: Global config, key binding, probe and the admin API (server)
**Files:**
- New store and port: `src/store/custom-provider.ts`, plus the `CustomProviderStore` port in `src/core/ports.ts`
- `src/core/custom-provider-auth.ts`
- `src/server/custom-provider.ts`, `custom-provider-http.ts`, `custom-provider-body.ts`, `custom-provider-auth.ts`
- `src/store/auth.ts` (binding entry)
- `app/api/custom-provider/route.ts`: GET status, POST connect/edit, DELETE disconnect, PATCH pins/rates/pricing. ETag/If-Match, as upstream does.
- `src/server/keys.ts` (redaction)

**Tests:** port `custom-provider-boundaries`, `-lifecycle`, `-restart` and `-route`, adapted to the global store and admin gating. Add these fork cases:
- a non-admin gets 403 on every mutation;
- the config file is mode 0600, and a corrupt file blocks writes;
- an edit to a different URL drops the key binding.

- [ ] RED → implement → GREEN → commit `feat(upstream): admin-managed custom provider — config, key binding, probe, API`.

### Task 2: Engine, pricing, gate and catalog
**Files:**
- `src/agent/models.ts`: inject `configureProviderSource` from the server. Sync the `custom` provider into `piModels()` from the global config. After `modelGate`, revalidate the custom model and apply the image clone and per-request thinking (313a3c8).
- `src/server/pricing.ts`: `free` → priced $0; `paid` → rates; no rates → unpriced.
- `src/server/model-gate.ts` and `policy.ts`: exclude paid-without-rates custom models from a capped restricted user's allowed set.
- `src/server/model-catalog.ts`: list custom models, with image-capable ones first for vision (5b1fd81), and apply the same exclusion.
- Every provider:id split uses the first colon only (audit and fix).

**Tests:**
- a custom model streams through the gate with faux fetch;
- free mode logs `providerCostUsd: 0` and the cap counts $0;
- paid mode with rates prices the call correctly;
- a capped user with a paid model that has no rates gets 403 `model_not_allowed`, and the model is missing from their `/api/models`;
- `custom:qwen3:8b` round-trips through the policy, the request log and `prettyModel`;
- a model removed from the snapshot mid-session refuses cleanly.

- [ ] RED → implement → GREEN → commit `feat(upstream): custom models in the engine, priced and gated`.

### Task 3: Admin UI
**Files:**
- `components/settings/keys-section.tsx` (admin-only "Custom endpoint" editor): base URL, keyless/key, free/paid, manual model ids, per-model pins (context, max output, reasoning), per-model rates when paid, and disconnect.
- Users editor and defaults box: list the custom models; a paid model without rates shows a hint and is not selectable for capped users.
- `components/setup-dialog.tsx`: non-admin variant.

**Tests:** port `custom-provider-ui.test.tsx`, adapted. Add fork render cases:
- a non-admin sees no editor;
- the paid-without-rates hint shows;
- the rates fields appear only in paid mode.

- [ ] RED → implement → GREEN → commit `feat(upstream): custom endpoint editor (admin)`.

### Task 4: LAN exception (NixOS) and docs
**Files:**
- `deploy/nixos/wireguard.nix`: `lanAllow` option (list of `"ip:port"`), adding RETURN rules before the LAN rejects in the host and container egress chains. Idempotent; stop commands clean up.
- `docs/self-hosting.md`: a custom provider section covering an Ollama on the LAN (set `lanAllow` and rebuild; use `http://<lan-ip>:11434/v1`), free vs paid and rates, and admin-only.
- `docs/architecture.md`: seam line.

**Verify:**
- `nix build ./deploy/nixos#nixosConfigurations.learnharness.config.system.build.toplevel --no-link`
- the full gate line

- [ ] Bump the version to 0.39.0 → commit `feat(deploy): LAN exception for a local model server; custom provider docs`.

### Task 5: Deploy (controller)
Merge, then `nixos-rebuild test` → `switch` (the firewall option exists but defaults to an empty list), then `systemctl restart learnharness-stack`. Check health and that `/api/custom-provider` returns not-configured. Tag v0.39.0 and publish the release.
