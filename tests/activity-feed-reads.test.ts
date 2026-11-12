/**
 * The activity feed is polled by every open window on each jobs-changed
 * event, so its file reads must not multiply with the number of chats:
 * one read per job file, and a chat record only for a chat that has a
 * running job (its title), never one per chat or one per (chat, job).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import test from "node:test";

import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { PATHS } from "../config.ts";
import { activityFeed } from "../src/server/observability.ts";

test("activityFeed reads each job file once and no chat without a running job", () => {
	const chats = Array.from({ length: 6 }, (_, i) => chatStore.createChat(`reads chat ${i}`));
	const jobs = [
		...chats.slice(0, 2).map((c, i) => jobStore.createJob({ kind: "research", chatId: c.id, toolCallId: `run_${i}` })),
		...chats.map((c, i) => jobStore.createJob({ kind: "research", chatId: c.id, toolCallId: `done_${i}` })),
	];
	for (const job of jobs.slice(2)) jobStore.updateJob(job.id, { status: "done" });
	const jobsDir = path.join(PATHS.data, "jobs");
	try {
		const reads = { chats: 0, jobs: 0 };
		const real = fs.readFileSync;
		// The stores use the ESM namespace of node:fs, so patch the CJS object and re-sync it.
		fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
			const dir = path.dirname(String(file));
			if (dir === PATHS.chats) reads.chats++;
			if (dir === jobsDir) reads.jobs++;
			return (real as (...a: unknown[]) => unknown)(file, ...rest);
		}) as typeof fs.readFileSync;
		syncBuiltinESMExports();
		let feed: ReturnType<typeof activityFeed>;
		try {
			feed = activityFeed();
		} finally {
			fs.readFileSync = real;
			syncBuiltinESMExports();
		}
		assert.deepEqual(
			feed.jobs.filter((j) => chats.some((c) => c.id === j.chatId)).map((j) => j.title).sort(),
			["reads chat 0", "reads chat 1"],
		);
		const jobFiles = fs.readdirSync(jobsDir).filter((f) => f.endsWith(".json")).length;
		assert.equal(reads.jobs, jobFiles, "each job file is read once per request");
		assert.equal(reads.chats, 2, "only chats with a running job are read, for their title");
	} finally {
		for (const c of chats) fs.unlinkSync(`${PATHS.chats}/${c.id}.json`);
		for (const j of jobs) fs.unlinkSync(path.join(jobsDir, `${j.id}.json`));
	}
});
