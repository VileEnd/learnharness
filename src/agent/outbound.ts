import * as dns from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import { Readable, pipeline } from "node:stream";
import * as zlib from "node:zlib";

/**
 * Outbound guard: the one way model-steered or user-supplied URLs leave the
 * process (the researcher's web_fetch / web_fetch_pdf, the demo browser's
 * http(s) subresources, Web Push endpoints). The app shares a network with
 * Keycloak, oauth2-proxy, the OCR sidecar and Postgres and sits on a home
 * LAN, so a URL the model read on an untrusted page must never reach any of
 * them.
 *
 * The rules:
 * - only http(s); names like `localhost`, single-label names (compose
 *   service names) and private suffixes (`.local`, `.internal`, ...) are
 *   refused before any lookup;
 * - every address a name resolves to must be public (classifyAddress); one
 *   non-public answer refuses the whole name;
 * - the connection goes to an address that was checked: the checked lookup
 *   result is pinned into the socket's own lookup, so there is no second DNS
 *   query between check and connect (no rebinding window);
 * - redirects are followed by hand, each hop re-checked, at most
 *   MAX_REDIRECTS of them;
 * - bodies are read through readCapped, which counts the bytes as they
 *   arrive (a missing or lying Content-Length changes nothing);
 * - the caller's AbortSignal reaches the socket.
 *
 * It lives in the agent layer so both the agent's tools and the server
 * (push.ts) may import it (the logged-fetch precedent). Tests inject the
 * lookup and the pinned transport (`outboundOverride`, or the `deps`
 * argument), so no suite needs a network.
 */

export class OutboundRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OutboundRefusedError";
	}
}

export interface ResolvedAddress {
	address: string;
	family: 4 | 6;
}

/** Resolve a hostname to every address it has. */
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

/** One request to already-checked addresses. */
export interface PinnedRequest {
	url: URL;
	/** Every address the host resolved to, all checked; the connection
	 *  must go to one of them (first choice first). Never empty. */
	addresses: ResolvedAddress[];
	method: "GET" | "HEAD";
	headers: Record<string, string>;
	signal?: AbortSignal;
}

/** The transport: perform one request (no redirect following) against the
 *  pinned address. */
export type PinnedFetch = (req: PinnedRequest) => Promise<Response>;

export interface OutboundDeps {
	lookup?: LookupFn;
	fetch?: PinnedFetch;
}

/** Test seam (headlessOverride idiom): undefined in production. */
export const outboundOverride: { current?: OutboundDeps } = {};

export const MAX_REDIRECTS = 5;

// ─── address classification ──────────────────────────────────────────────────

/** IPv4 ranges that are never a public destination. The documentation
 *  ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) are not listed:
 *  they are unroutable on the internet, so allowing them reaches nothing,
 *  and tests use them as stand-in public addresses. */
const V4_REFUSED: Array<[base: string, prefix: number, label: string]> = [
	["0.0.0.0", 8, "unspecified"],
	["10.0.0.0", 8, "private"],
	["100.64.0.0", 10, "carrier-grade NAT"],
	["127.0.0.0", 8, "loopback"],
	["169.254.0.0", 16, "link-local"],
	["172.16.0.0", 12, "private"],
	["192.0.0.0", 24, "special-purpose"],
	["192.168.0.0", 16, "private"],
	["198.18.0.0", 15, "benchmarking"],
	["224.0.0.0", 4, "multicast"],
	["240.0.0.0", 4, "reserved"],
];

function v4ToInt(ip: string): number {
	return ip.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
}

function classifyV4(ip: string): string | null {
	const n = v4ToInt(ip);
	for (const [base, prefix, label] of V4_REFUSED) {
		const size = 2 ** (32 - prefix);
		const start = v4ToInt(base);
		if (n >= start && n < start + size) return label;
	}
	return null;
}

/** Parse an IPv6 literal (net.isIPv6-valid, zone index allowed) to 16 bytes. */
function v6Bytes(ip: string): number[] | null {
	let s = ip.split("%")[0] ?? "";
	const tail: number[] = [];
	const lastColon = s.lastIndexOf(":");
	const maybeV4 = s.slice(lastColon + 1);
	if (maybeV4.includes(".")) {
		if (!net.isIPv4(maybeV4)) return null;
		for (const part of maybeV4.split(".")) tail.push(Number(part));
		s = `${s.slice(0, lastColon + 1)}0:0`;
	}
	const halves = s.split("::");
	if (halves.length > 2) return null;
	const parse = (part: string | undefined): number[] =>
		part ? part.split(":").map((h) => Number.parseInt(h, 16)) : [];
	const head = parse(halves[0]);
	const rest = halves.length === 2 ? parse(halves[1]) : [];
	const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
	const words = [...head, ...new Array<number>(Math.max(fill, 0)).fill(0), ...rest];
	if (words.length !== 8 || words.some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) return null;
	const bytes = words.flatMap((w) => [w >> 8, w & 0xff]);
	if (tail.length === 4) bytes.splice(12, 4, ...tail);
	return bytes;
}

function startsWith(bytes: number[], prefix: number[], bits: number): boolean {
	for (let i = 0; i < bits; i++) {
		const byte = Math.floor(i / 8);
		const mask = 0x80 >> i % 8;
		if (((bytes[byte] ?? 0) & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
	}
	return true;
}

function embeddedV4(bytes: number[], offset: number): string {
	return bytes.slice(offset, offset + 4).join(".");
}

function classifyV6(ip: string): string | null {
	const b = v6Bytes(ip);
	if (!b) return "unparseable";
	const zero = (n: number) => b.slice(0, n).every((x) => x === 0);
	if (b.every((x) => x === 0)) return "unspecified";
	if (zero(15) && b[15] === 1) return "loopback";
	// ::ffff:a.b.c.d (IPv4-mapped) and ::ffff:0:a.b.c.d (IPv4-translated):
	// the connection goes to the IPv4 address, so it decides.
	if (zero(10) && b[10] === 0xff && b[11] === 0xff) return mappedVerdict(embeddedV4(b, 12));
	if (zero(8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return mappedVerdict(embeddedV4(b, 12));
	if (zero(12)) return "IPv4-compatible";
	// NAT64 (64:ff9b::/96) reaches the embedded IPv4 address.
	if (startsWith(b, [0x00, 0x64, 0xff, 0x9b], 96)) return mappedVerdict(embeddedV4(b, 12));
	if (startsWith(b, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)) return "local NAT64";
	if (startsWith(b, [0x01, 0x00], 64)) return "discard";
	if (startsWith(b, [0x20, 0x01, 0x00, 0x00], 32)) return "Teredo";
	// 6to4 (2002::/16) carries an IPv4 address in bits 16-47.
	if (startsWith(b, [0x20, 0x02], 16)) return mappedVerdict(embeddedV4(b, 2));
	if (startsWith(b, [0xfc], 7)) return "unique-local";
	if (startsWith(b, [0xfe, 0x80], 10)) return "link-local";
	if (startsWith(b, [0xfe, 0xc0], 10)) return "site-local";
	if (startsWith(b, [0xff], 8)) return "multicast";
	return null;
}

function mappedVerdict(v4: string): string | null {
	const inner = classifyV4(v4);
	return inner ? `IPv4-embedded ${inner}` : null;
}

/** Why an IP address is not a public destination, or null when it is.
 *  Non-IP input is refused ("not an IP address"). */
export function classifyAddress(ip: string): string | null {
	const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
	const family = net.isIP(bare.split("%")[0] ?? "");
	if (family === 4) return classifyV4(bare);
	if (family === 6) return classifyV6(bare);
	return "not an IP address";
}

/** Suffixes that only ever name hosts on a private network. */
const PRIVATE_SUFFIXES = [
	".localhost",
	".local",
	".internal",
	".localdomain",
	".home.arpa",
	".lan",
	".home",
	".corp",
	".intranet",
	".private",
];

/** Why a URL hostname (WHATWG-parsed: lower-case, IPv6 in brackets) is
 *  refused before any lookup, or null when it may be resolved. IP literals
 *  are classified here. */
export function hostRefusal(hostname: string): string | null {
	const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	if (net.isIP(bare.split("%")[0] ?? "")) {
		const verdict = classifyAddress(bare);
		return verdict ? `${verdict} address` : null;
	}
	const name = bare.toLowerCase().replace(/\.+$/, "");
	if (name.length === 0) return "empty host";
	if (name === "localhost") return "localhost";
	if (!name.includes(".")) return "single-label host name";
	const suffix = PRIVATE_SUFFIXES.find((s) => name.endsWith(s));
	if (suffix) return `private name (${suffix})`;
	return null;
}

const defaultLookup: LookupFn = async (hostname) => {
	const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
	return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

function depsOf(deps?: OutboundDeps): Required<OutboundDeps> {
	return {
		lookup: deps?.lookup ?? outboundOverride.current?.lookup ?? defaultLookup,
		fetch: deps?.fetch ?? outboundOverride.current?.fetch ?? nodePinnedFetch,
	};
}

/** Check a URL and return the public addresses to connect to (all of the
 *  host's answers, every one checked; never empty). Throws
 *  OutboundRefusedError for a refused scheme, name or address; a failed
 *  lookup throws its own error. The refusal never names the internal
 *  address (the model reads these messages). */
export async function resolvePublicTarget(url: URL, lookup?: LookupFn): Promise<ResolvedAddress[]> {
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new OutboundRefusedError(`refused: only http(s) URLs are allowed (got ${url.protocol})`);
	const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
	const refusal = hostRefusal(url.hostname);
	if (refusal) throw new OutboundRefusedError(`refused: ${url.hostname} is not a public host (${refusal})`);
	const literal = net.isIP(host);
	if (literal) return [{ address: host, family: literal === 6 ? 6 : 4 }];
	const answers = await (lookup ?? depsOf().lookup)(host);
	if (answers.length === 0) throw new Error(`${host} did not resolve`);
	for (const a of answers) {
		const verdict = classifyAddress(a.address);
		if (verdict) throw new OutboundRefusedError(`refused: ${host} resolves to a non-public address (${verdict})`);
	}
	return answers;
}

/** A socket lookup that answers only with these (checked) addresses. */
function pinnedLookup(addresses: ResolvedAddress[]) {
	return (
		_hostname: string,
		options: LookupOptions,
		callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
	) => {
		const first = addresses[0]!;
		if (options.all) callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
		else callback(null, first.address, first.family);
	};
}

// ─── the default transport (node:http/https, pinned) ─────────────────────────

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** One request over node:http(s) whose socket lookup returns only the
 *  checked addresses, so the connection cannot go anywhere else. TLS still
 *  verifies the URL's host name. Decompresses gzip/deflate/br (the size cap
 *  then applies to the decoded bytes). */
export const nodePinnedFetch: PinnedFetch = (req) =>
	new Promise<Response>((resolve, reject) => {
		const transport = req.url.protocol === "https:" ? https : http;
		const headers = { "accept-encoding": "gzip, deflate, br", ...req.headers };
		const request = transport.request(
			req.url,
			{ method: req.method, headers, signal: req.signal, lookup: pinnedLookup(req.addresses), agent: false },
			(res) => {
				const status = res.statusCode ?? 0;
				const out = new Headers();
				for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
					try {
						out.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
					} catch {
						/* a header the Fetch API cannot carry: dropped */
					}
				}
				if (status < 200 || status > 599) {
					res.destroy();
					reject(new Error(`Unexpected HTTP status ${status}`));
					return;
				}
				const nullBody = req.method === "HEAD" || NULL_BODY_STATUSES.has(status);
				let body: Readable = res;
				const encoding = (out.get("content-encoding") ?? "").trim().toLowerCase();
				const decoder =
					encoding === "gzip" || encoding === "x-gzip"
						? zlib.createGunzip()
						: encoding === "deflate"
							? zlib.createInflate()
							: encoding === "br"
								? zlib.createBrotliDecompress()
								: null;
				if (decoder && !nullBody) {
					out.delete("content-encoding");
					out.delete("content-length");
					body = pipeline(res, decoder, () => {});
				}
				if (nullBody) res.resume();
				const stream = nullBody ? null : (Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>);
				let response: Response;
				try {
					response = new Response(stream, { status, statusText: res.statusMessage ?? "", headers: out });
				} catch {
					response = new Response(stream, { status, headers: out });
				}
				resolve(response);
			},
		);
		request.on("error", reject);
		request.end();
	});

// ─── guarded fetch ───────────────────────────────────────────────────────────

export interface GuardedFetchInit {
	method?: "GET" | "HEAD";
	headers?: Record<string, string>;
	signal?: AbortSignal;
	maxRedirects?: number;
}

export interface GuardedFetchResult {
	response: Response;
	/** The final URL after redirects. */
	url: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Fetch a URL through the guard: every hop checked, every connection
 *  pinned to its checked address, redirects followed by hand. The caller
 *  reads the body with readCapped. */
export async function guardedFetch(
	rawUrl: string,
	init: GuardedFetchInit = {},
	deps?: OutboundDeps,
): Promise<GuardedFetchResult> {
	const { lookup, fetch } = depsOf(deps);
	const maxRedirects = init.maxRedirects ?? MAX_REDIRECTS;
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new OutboundRefusedError(`refused: invalid URL`);
	}
	for (let hop = 0; ; hop++) {
		init.signal?.throwIfAborted();
		const addresses = await resolvePublicTarget(url, lookup);
		const response = await fetch({
			url,
			addresses,
			method: init.method ?? "GET",
			headers: init.headers ?? {},
			...(init.signal ? { signal: init.signal } : {}),
		});
		const location = response.headers.get("location");
		if (!REDIRECT_STATUSES.has(response.status) || location === null) return { response, url: url.href };
		await response.body?.cancel().catch(() => {});
		if (hop >= maxRedirects) throw new Error(`Too many redirects (more than ${maxRedirects})`);
		try {
			url = new URL(location, url);
		} catch {
			throw new Error("Redirect to an invalid URL");
		}
	}
}

/** Read a body, refusing it as soon as more than maxBytes have arrived. A
 *  declared Content-Length over the cap fails before reading. `charge` sees
 *  every chunk as it arrives (a shared budget across bodies); a throw from it
 *  stops the read and is rethrown. */
export async function readCapped(
	response: Response,
	maxBytes: number,
	tooLargeMessage = "Response too large",
	charge?: (bytes: number) => void,
): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => {});
		throw new Error(tooLargeMessage);
	}
	if (!response.body) return new Uint8Array(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new Error(tooLargeMessage);
		}
		try {
			charge?.(value.byteLength);
		} catch (err) {
			await reader.cancel().catch(() => {});
			throw err;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

/** The caller's signal plus a timeout of its own (whichever fires first). */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// ─── an https.Agent for libraries that do their own requests (web-push) ─────

/** An https.Agent that refuses non-public destinations at connect time: a
 *  host name is resolved through the lookup and every answer checked (the
 *  socket connects only to checked addresses), and an IP literal host is
 *  classified directly (net skips the lookup for literals). */
export function guardedHttpsAgent(lookup?: LookupFn): https.Agent {
	const resolve: LookupFn = (hostname) => (lookup ?? depsOf().lookup)(hostname);
	const checkedLookup = (
		hostname: string,
		options: LookupOptions,
		callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
	) => {
		resolvePublicTarget(new URL(`https://${hostname.includes(":") ? `[${hostname}]` : hostname}/`), resolve).then(
			(addresses) => pinnedLookup(addresses)(hostname, options, callback),
			(err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), ""),
		);
	};
	class GuardedAgent extends https.Agent {
		override createConnection(
			options: https.RequestOptions,
			callback?: (err: Error | null, stream: Duplex) => void,
		): Duplex | null | undefined {
			const host = options.host ?? options.hostname ?? "";
			const bare = host.startsWith("[") ? host.slice(1, -1) : host;
			if (net.isIP(bare)) {
				const verdict = classifyAddress(bare);
				if (verdict) {
					callback?.(new OutboundRefusedError(`refused: ${verdict} address`), undefined as unknown as Duplex);
					return undefined;
				}
			}
			return super.createConnection({ ...options, lookup: checkedLookup }, callback);
		}
	}
	return new GuardedAgent();
}
