/**
 * migrate-to-tenants.mjs — one-off move of a single-user data dir into the
 * multi-user layout. Plain ESM (runs as bare `node` in the image):
 *
 *   node scripts/migrate-to-tenants.mjs --owner <keycloak-sub>
 *
 * Every top-level entry of the data dir (LH_DATA_DIR) except users/ and
 * global/ moves to users/<owner>/; push/vapid.json and prompts/ then move to
 * global/. renameSync only (same filesystem), nothing is copied. Refuses
 * to run if users/ already exists.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

// Twin of TENANT_ID_RE in src/core/tenant-context.ts.
const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function fail(msg) {
	console.error(`migrate-to-tenants: ${msg}`);
	process.exit(1);
}

const args = process.argv.slice(2);
const at = args.indexOf("--owner");
const owner = at >= 0 ? args[at + 1] : undefined;
if (!owner || !TENANT_ID_RE.test(owner)) fail("--owner <keycloak-sub> is required (lowercase letters, digits, '-'; max 64)");

const root = path.resolve(process.env.LH_DATA_DIR ?? path.join(import.meta.dirname, "..", "data"));
if (!fs.existsSync(root)) fail(`data dir not found: ${root}`);
if (fs.existsSync(path.join(root, "users"))) fail("users/ already exists; nothing to migrate");

const dest = path.join(root, "users", owner);
const shared = path.join(root, "global");
// Pre-flight: refuse before any change if a shared destination is taken.
for (const taken of [path.join(shared, "prompts"), path.join(shared, "push", "vapid.json")]) {
	if (fs.existsSync(taken)) fail(`${taken} already exists; nothing changed`);
}

// Run as root (docker exec default), the dirs we create must still belong to the data owner.
const { uid, gid } = fs.statSync(root);
const asRoot = process.getuid?.() === 0;
function mkdirOwned(dir) {
	const first = fs.mkdirSync(dir, { recursive: true });
	if (!asRoot || !first) return;
	// first = topmost dir created; chown it and everything down to dir.
	for (let d = dir; ; d = path.dirname(d)) {
		fs.chownSync(d, uid, gid);
		if (d === first) break;
	}
}
mkdirOwned(dest);
mkdirOwned(shared);

let moved = 0;
for (const name of fs.readdirSync(root)) {
	if (name === "users" || name === "global") continue;
	fs.renameSync(path.join(root, name), path.join(dest, name));
	moved++;
}

const vapid = path.join(dest, "push", "vapid.json");
if (fs.existsSync(vapid)) {
	mkdirOwned(path.join(shared, "push"));
	fs.renameSync(vapid, path.join(shared, "push", "vapid.json"));
}
const prompts = path.join(dest, "prompts");
if (fs.existsSync(prompts)) fs.renameSync(prompts, path.join(shared, "prompts"));

console.log(`migrated ${moved} entries to ${dest}`);
