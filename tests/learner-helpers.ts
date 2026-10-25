/**
 * Hand-built chat records for the learner-model tests: assistant tool calls,
 * the learner's answers (the toolResult's `details` is the full graded
 * QuestionAnswerData), grades and practice conclusions.
 */
import type { ChatRecord } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

let seq = 0;
const nextId = () => `m${++seq}`;

export function call(id: string, name: string, args: Record<string, unknown>, timestamp = 1_000): LhMessage {
	return {
		id: nextId(),
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp,
	} as unknown as LhMessage;
}

export function result(id: string, name: string, details: unknown, timestamp = 2_000, isError = false): LhMessage {
	return {
		id: nextId(),
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: isError ? "error" : "ok" }],
		details,
		isError,
		timestamp,
	} as unknown as LhMessage;
}

export const OPTIONS = [
	{ index: 1, label: "P decrements" },
	{ index: 2, label: "P increments" },
];

/** A quiz call + its answer. `pick` is the 1-based index the learner chose. */
export function quiz(
	id: string,
	opts: { type?: string; pick?: number; confidence?: number; thinking?: string; concepts?: string[]; dismissed?: boolean; dontKnow?: boolean; at?: string; tool?: "quiz" | "probe" },
): LhMessage[] {
	const tool = opts.tool ?? "quiz";
	const args = { question: `Q ${id}`, ...(opts.type ? { type: opts.type } : {}), ...(opts.concepts ? { concepts: opts.concepts } : {}) };
	const at = opts.at ?? "2026-10-20T10:00:00.000Z";
	const details = opts.dismissed
		? { kind: "quiz", questionText: `Q ${id}`, dontKnow: false, answers: [], dismissed: true, answeredAt: at }
		: opts.dontKnow
			? { kind: "quiz", questionText: `Q ${id}`, dontKnow: true, answers: [], options: OPTIONS, correctIndices: [1], correct: false, answeredAt: at }
			: {
					kind: "quiz",
					questionText: `Q ${id}`,
					dontKnow: false,
					options: OPTIONS,
					answers: [{ ...OPTIONS[(opts.pick ?? 1) - 1]!, value: String(opts.pick ?? 1) }],
					correctIndices: [1],
					correct: (opts.pick ?? 1) === 1,
					...(opts.confidence !== undefined ? { confidence: opts.confidence } : {}),
					...(opts.thinking ? { thinking: opts.thinking } : {}),
					answeredAt: at,
				};
	return [call(id, tool, args), result(id, tool, details)];
}

/** An explain/recall call + his free-text answer (ungraded until `grade()`). */
export function explain(id: string, opts: { type?: string; concepts?: string[]; tool?: "explain" | "recall" } = {}): LhMessage[] {
	const tool = opts.tool ?? "explain";
	return [
		call(id, tool, { question: `Explain ${id}`, correctAnswer: "because", ...(opts.type ? { type: opts.type } : {}), ...(opts.concepts ? { concepts: opts.concepts } : {}) }),
		result(id, tool, { kind: "explain", questionText: `Explain ${id}`, dontKnow: false, answers: [], text: "my words", answeredAt: "2026-10-20T10:00:00.000Z" }),
	];
}

export function grade(
	callId: string,
	question: string,
	g: string,
	extra: { note?: string; misconception?: { term: string; instead: string; why?: string }; isError?: boolean; timestamp?: number } = {},
): LhMessage[] {
	return [
		call(callId, "grade", { question, grade: g, note: extra.note ?? "n", ...(extra.misconception ? { misconception: extra.misconception } : {}) }),
		result(callId, "grade", `Recorded: ${g}.`, extra.timestamp ?? Date.parse("2026-10-20T10:05:00.000Z"), extra.isError === true),
	];
}

export function problem(id: string, target?: string[]): LhMessage[] {
	return [call(id, "problem", { statement: `Solve ${id}`, mode: "recall", modelSolution: "x", ...(target ? { target } : {}) }), result(id, "problem", null)];
}

export function conclude(id: string, outcome: string, verdict = "v"): LhMessage[] {
	return [
		call(id, "conclude", { outcome, verdict, rung: null, missClass: null, retest: false }),
		result(id, "conclude", null, Date.parse("2026-10-21T10:00:00.000Z")),
	];
}

export function chat(id: string, messages: LhMessage[], kind?: "practice"): ChatRecord {
	return { id, title: id, createdAt: "2026-10-20T09:00:00.000Z", updatedAt: "2026-10-20T11:00:00.000Z", messages, ...(kind ? { kind } : {}) };
}

/** A teacher prose message (visible to extraction coverage). */
export function prose(text: string): LhMessage {
	return { ...call("unused", "x", {}), content: [{ type: "text", text }] } as unknown as LhMessage;
}
