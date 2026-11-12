import { loggedFetch, type FetchLike } from "./logged-fetch.ts";

/** The fetch the speech-token route mints with: each grant is one request-log
 *  line. The grant itself reports no cost, so the line carries none (absent,
 *  never zero). Resolves global fetch per call so a stub installed later holds. */
export function deepgramGrantFetch(): FetchLike {
	return loggedFetch((input, init) => fetch(input, init), { purpose: "dictation", provider: "deepgram", model: "token-grant" });
}
