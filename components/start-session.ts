import { clearOpeningPrompt, OPENING_PROMPT_FAILURE, stashOpeningPrompt } from "@/components/opening-prompt";
import { chatCreateFailure } from "@/src/core";

interface SessionCreation {
	title: string;
	kind?: "practice";
	graphContext?: { propositions: readonly { id: string; name: string; statement: string }[] };
	canvas?: true;
}

/** Per source-composer instance. Retain a successful creation if storage
 * fails, so an unchanged retry does not create another empty session.
 * Changed text/context/settings is a different start, not a stale title.
 * A refused create (the spending cap, 403) creates no chat, stashes nothing
 * and throws the refusal's own copy so the caller keeps the draft.
 */
export class SessionStarter {
	private created?: { identity: string; id: string };

	async start(body: SessionCreation, fetchLike: typeof fetch, settingsIdentity?: string): Promise<string> {
		const identity = JSON.stringify([body, settingsIdentity]);
		if (this.created?.identity !== identity) {
			if (this.created) clearOpeningPrompt(this.created.id);
			this.created = undefined;
			// A network failure rejects with the browser's own text ("Failed to
			// fetch"): say the approved copy instead.
			const res = await fetchLike("/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}).catch(() => { throw new Error(OPENING_PROMPT_FAILURE); });
			if (!res.ok) throw new Error(await chatCreateFailure(res));
			const result = await res.json() as { id?: unknown };
			if (typeof result.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(result.id)) throw new Error(OPENING_PROMPT_FAILURE);
			this.created = { identity, id: result.id };
		}
		if (!stashOpeningPrompt(this.created.id, body.title)) throw new Error(OPENING_PROMPT_FAILURE);
		return `/chat/${this.created.id}`;
	}
}
