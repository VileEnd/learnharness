/** An over-cap user's dictation error is the spending-limit copy, not "token route 403". */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mintFreshToken } from "../components/dictation.tsx";
import { monthlyCapReached } from "../src/core/settings.ts";

const answer = (status: number, body: unknown) => (async () => Response.json(body, { status })) as typeof fetch;

test("the token route's 403 policy envelope becomes the spending-limit message", async () => {
	await assert.rejects(mintFreshToken(answer(403, monthlyCapReached(5, 5.1))), /spending limit \(\$5\)\. Ask your admin to raise it\./);
});

test("other failures keep their message, then the status", async () => {
	await assert.rejects(mintFreshToken(answer(502, { message: "Deepgram unreachable" })), /Deepgram unreachable/);
	await assert.rejects(mintFreshToken((async () => new Response("<html>", { status: 500 })) as typeof fetch), /token route 500/);
});
