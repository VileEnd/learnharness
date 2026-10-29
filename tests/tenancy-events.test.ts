import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emit } from "../src/core/events.ts";
import { runAsTenant } from "../src/core/tenant-context.ts";
import { eventsResponse } from "../src/server/events-stream.ts";

const tenant = (id: string) => ({ id, name: id, isAdmin: false });

describe("tenant-scoped events", () => {
	it("delivers only the subscriber's tenant events and never serialises tenant", async () => {
		const res = eventsResponse("b");
		const reader = res.body!.getReader();
		runAsTenant(tenant("a"), () => emit("chats-changed", {}));
		runAsTenant(tenant("b"), () => emit("chats-changed", {}));
		runAsTenant(tenant("b"), () => emit("record-changed", { chatId: "end" }));
		let text = "";
		while (!text.includes("record-changed")) {
			const { value } = await reader.read();
			text += new TextDecoder().decode(value);
		}
		await reader.cancel();
		assert.equal(text.match(/event: chats-changed/g)?.length, 1);
		assert.ok(!text.includes("tenant"));
	});
});
