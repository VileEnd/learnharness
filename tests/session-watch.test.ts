/** Which requests the signed-out watch treats as the guarded API. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { isOwnApiRequest } from "../components/session-watch.tsx";

it("only this origin's /api/* counts", () => {
	const origin = "https://learnharness.example";
	assert.equal(isOwnApiRequest("/api/chats", origin), true);
	assert.equal(isOwnApiRequest(new URL("/api/events", origin), origin), true);
	assert.equal(isOwnApiRequest("/chat/abc", origin), false);
	assert.equal(isOwnApiRequest("https://api.deepgram.com/api/x", origin), false);
});
