/**
 * The learner model's EVIDENCE layer (pure). What the learner has shown, per
 * concept, is derived at read time from the persisted chat records plus the
 * attribution ledger; nothing is stored as a score (the record is the only
 * source of truth).
 *
 * The mapping, exactly:
 *   quiz / probe   correct, confidence absent or above TENTATIVE_MAX_CONFIDENCE -> clean
 *                  correct, confidence at or below it                          -> weak   (raw "tentative")
 *                  miss, don't know                                            -> failed
 *   explain / recall  only through a `grade` call:
 *                  correct -> clean, partly -> weak, wrong / dontKnow -> failed
 *   practice       solved -> clean, solvedWithHints -> weak, surrendered / movedOn -> failed
 *   NOT evidence   predictions (`type: "predict"`; a record without `type` is a check),
 *                  dismissed questions, dismissed problems, an explain/recall nobody graded.
 *
 * A graded item belongs to the concepts it was TAGGED with (`concepts`, or a
 * practice problem's `target`) plus the concepts the attribution ledger links
 * it to, restricted to ids that still exist.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
	AttributionRow,
	ChatRecord,
	ConceptState,
	ConceptStateName,
	CoverageEntry,
	EvidenceEvent,
	EvidenceResult,
	GraphChain,
	LearnerSnapshot,
} from "./contracts.ts";
import { coverageOf } from "./coverage.ts";
import { PRACTICE_CONCLUDE_TOOL, problemInputForConclude, WORK_TOOLS, workSubmissionsOf, type LhMessage } from "./native-messages.ts";
import { normalizeQuizType, type QuestionAnswerData } from "./question-core.ts";
import type { ExerciseVerdict } from "./exercise-core.ts";

/** A correct answer at or below this stated confidence (the slider's active
 *  doubt) counts as tentative, not clean. The untouched default 50 is clean. */
export const TENTATIVE_MAX_CONFIDENCE = 30;

/** Days until the next review, by streak (1, 2, 3, 4 or more clean spaced sessions). */
export const REVIEW_INTERVAL_DAYS = [3, 7, 21, 60] as const;
/** A clean session advances the streak only this many hours after the previous counted one. */
export const MIN_SPACING_HOURS = 20;

const QUIZ_CALLS = ["quiz", "probe"] as const;
const RECALL_CALLS = ["explain", "recall"] as const;
const EXERCISE_CALLS = ["exercise", "assess"] as const;
/** The R0-R5 hint ladder; a canvas task graded correct at R2 or above counts as helped. */
const RUNGS = ["R0", "R1", "R2", "R3", "R4", "R5"] as const;
const HELPED_RUNG_INDEX = 2;
const GRADES = ["correct", "partly", "wrong", "dontKnow"] as const;
const PRACTICE_OUTCOMES = ["solved", "solvedWithHints", "movedOn", "surrendered"] as const;

type Grade = (typeof GRADES)[number];

/** One graded item of a chat, before concept resolution. */
export interface GradedItem {
	chatId: string;
	/** The question call (quiz / probe / explain / recall) or the practice conclude call. */
	toolCallId: string;
	kind: EvidenceEvent["kind"];
	at: string;
	raw: string;
	result: EvidenceResult;
	note?: string;
	misconception?: EvidenceEvent["misconception"];
	/** The concept ids the call itself carried (`concepts`, or the problem's `target`). */
	tags: string[];
	/** For the attribution agent: what was asked and what came back. */
	question: string;
	answer: string;
	/** The correct answer in words (quiz: the correct option labels; explain/recall: the committed `correctAnswer`); "" when unknown. */
	correct: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const iso = (ms: number): string => new Date(Number.isFinite(ms) ? ms : 0).toISOString();

export interface ToolCallBlock {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

function toolCallsOf(messages: readonly LhMessage[]): ToolCallBlock[] {
	const out: ToolCallBlock[] = [];
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		for (const b of (m as AssistantMessage).content) {
			if (b.type === "toolCall") out.push({ id: b.id, name: b.name, arguments: isObject(b.arguments) ? b.arguments : {} });
		}
	}
	return out;
}

/** The clean (non-error) results by call id. */
function cleanResults(messages: readonly LhMessage[]): Map<string, ToolResultMessage> {
	const out = new Map<string, ToolResultMessage>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const r = m as ToolResultMessage;
		if (!r.isError) out.set(r.toolCallId, r);
	}
	return out;
}

interface RecordedGrade {
	grade: Grade;
	note?: string;
	misconception?: EvidenceEvent["misconception"];
	/** work/sketch only: the highest hint rung given. */
	rung?: string;
	at: string;
}

/** The first clean `grade` call per question id (one grade per question). */
function gradesOf(calls: readonly ToolCallBlock[], results: Map<string, ToolResultMessage>): Map<string, RecordedGrade> {
	const out = new Map<string, RecordedGrade>();
	for (const c of calls) {
		if (c.name !== "grade") continue;
		const result = results.get(c.id);
		if (!result) continue;
		const question = str(c.arguments.question);
		const grade = c.arguments.grade;
		if (!question || out.has(question) || !(GRADES as readonly unknown[]).includes(grade)) continue;
		const mis = isObject(c.arguments.misconception) ? c.arguments.misconception : undefined;
		const term = str(mis?.term);
		const misconception =
			term && (grade === "partly" || grade === "wrong")
				? { term, ...(str(mis?.instead) ? { instead: str(mis?.instead)! } : {}), ...(str(mis?.why) ? { why: str(mis?.why)! } : {}) }
				: undefined;
		out.set(question, {
			grade: grade as Grade,
			...(str(c.arguments.note) ? { note: str(c.arguments.note)! } : {}),
			...(misconception ? { misconception } : {}),
			...(typeof c.arguments.rung === "string" && (RUNGS as readonly string[]).includes(c.arguments.rung) ? { rung: c.arguments.rung } : {}),
			at: iso(result.timestamp),
		});
	}
	return out;
}

/** An answered, non-dismissed explain/recall: the answer record, or null. */
function answerOf(result: ToolResultMessage | undefined): QuestionAnswerData | null {
	const d = result?.details;
	if (!isObject(d) || d.dismissed === true) return null;
	return d as unknown as QuestionAnswerData;
}

/** Is this call "answered" for grading: an explain/recall with a real
 *  answer, or a canvas task (work/sketch) with at least one submission? */
function isAnsweredGradable(
	call: ToolCallBlock,
	results: Map<string, ToolResultMessage>,
	messages: readonly LhMessage[],
): boolean {
	if ((RECALL_CALLS as readonly string[]).includes(call.name)) return answerOf(results.get(call.id)) !== null;
	if ((WORK_TOOLS as readonly string[]).includes(call.name)) {
		return results.has(call.id) && workSubmissionsOf(messages, call.id).length > 0;
	}
	return false;
}

/** The ids of answered explain/recall calls (and canvas tasks with a
 *  submission) that no `grade` call covers yet (the `grade` tool stays
 *  registered while any exist). */
export function ungradedAnsweredRecalls(messages: readonly LhMessage[]): string[] {
	const calls = toolCallsOf(messages);
	const results = cleanResults(messages);
	const graded = gradesOf(calls, results);
	return calls.filter((c) => isAnsweredGradable(c, results, messages) && !graded.has(c.id)).map((c) => c.id);
}

/** The answered explain/recall call ids (plus work/sketch calls with a
 *  submission) of a record - what `grade` may target. */
export function answeredRecallIds(messages: readonly LhMessage[]): Set<string> {
	const calls = toolCallsOf(messages);
	const results = cleanResults(messages);
	return new Set(calls.filter((c) => isAnsweredGradable(c, results, messages)).map((c) => c.id));
}

/** The question ids a clean `grade` call already covers. */
export function gradedQuestionIds(messages: readonly LhMessage[]): Set<string> {
	return new Set(gradesOf(toolCallsOf(messages), cleanResults(messages)).keys());
}

const labelsOf = (answer: QuestionAnswerData, indices: readonly number[]): string[] =>
	(Array.isArray(answer.options) ? answer.options : []).filter((o) => indices.includes(o.index)).map((o) => o.label);

function quizItem(chat: ChatRecord, call: ToolCallBlock, answer: QuestionAnswerData, result: ToolResultMessage): GradedItem | null {
	const at = str(answer.answeredAt) ?? iso(result.timestamp);
	const note = str(answer.thinking) ?? str(answer.note);
	const correct = labelsOf(answer, Array.isArray(answer.correctIndices) ? answer.correctIndices : []).join("; ");
	const base = {
		correct,
		chatId: chat.id,
		toolCallId: call.id,
		kind: call.name as "quiz" | "probe",
		at,
		...(note ? { note } : {}),
		tags: strings(call.arguments.concepts),
		question: str(call.arguments.question) ?? "",
	};
	if (answer.dontKnow === true) {
		return { ...base, raw: "dontKnow", result: "failed", answer: "I don't know" };
	}
	const picked = (Array.isArray(answer.answers) ? answer.answers : []).map((a) => a.label).filter((l) => typeof l === "string");
	const answerText = picked.join("; ");
	if (answer.correct === true) {
		const tentative = typeof answer.confidence === "number" && answer.confidence <= TENTATIVE_MAX_CONFIDENCE;
		return { ...base, raw: tentative ? "tentative" : "correct", result: tentative ? "weak" : "clean", answer: answerText };
	}
	if (answer.correct === false) {
		const instead = labelsOf(answer, Array.isArray(answer.correctIndices) ? answer.correctIndices : []).join("; ");
		const misconception =
			picked.length > 0
				? { term: answerText, ...(instead ? { instead } : {}), ...(note ? { why: note } : {}) }
				: undefined;
		return { ...base, raw: "miss", result: "failed", answer: answerText, ...(misconception ? { misconception } : {}) };
	}
	return null;
}

/** The misconception an exercise miss exposed: the first wrong item of the
 *  first attempt (what the learner gave, against what was expected). */
function exerciseMisconception(answer: QuestionAnswerData): EvidenceEvent["misconception"] | undefined {
	const verdict: ExerciseVerdict | undefined = answer.firstAttempt?.verdict ?? answer.verdict;
	const wrong = (Array.isArray(verdict?.items) ? verdict.items : []).find((i) => !i.correct && str(i.given));
	if (!wrong) return undefined;
	const term = str(wrong.given)!;
	const instead = str(wrong.expected);
	return { term, ...(instead ? { instead } : {}) };
}

/** One answered `exercise` / `assess` call as a graded item. A clean first
 *  try without hints is clean (or tentative at low confidence); a success
 *  that needed retries or hints is weak, a give-up or a miss is failed. */
export function exerciseItem(chat: ChatRecord, call: ToolCallBlock, answer: QuestionAnswerData, result: ToolResultMessage): GradedItem | null {
	const at = str(answer.answeredAt) ?? iso(result.timestamp);
	const note = str(answer.thinking) ?? str(answer.note);
	const items = Array.isArray(answer.verdict?.items) ? answer.verdict.items : [];
	const given = items.map((i) => str(i.given)).filter((g): g is string => g !== undefined).join("; ");
	const expected = items.map((i) => str(i.expected)).filter((e): e is string => e !== undefined).join("; ");
	const base = {
		chatId: chat.id,
		toolCallId: call.id,
		kind: call.name as "exercise" | "assess",
		at,
		...(note ? { note } : {}),
		tags: strings(call.arguments.concepts),
		question: str(call.arguments.question) ?? "",
		correct: expected,
	};
	if (answer.dontKnow === true) return { ...base, raw: "dontKnow", result: "failed", answer: "I don't know" };
	const outcome = answer.verdict?.outcome ?? (answer.correct === true ? "correct" : undefined);
	if (answer.gaveUp === true) {
		const misconception = exerciseMisconception(answer);
		return { ...base, raw: "surrendered", result: "failed", answer: given, ...(misconception ? { misconception } : {}) };
	}
	if (outcome === "correct") {
		if ((answer.attempts ?? 1) === 1 && (answer.hintsUsed ?? 0) === 0) {
			const tentative = typeof answer.confidence === "number" && answer.confidence <= TENTATIVE_MAX_CONFIDENCE;
			return { ...base, raw: tentative ? "tentative" : "correct", result: tentative ? "weak" : "clean", answer: given };
		}
		return { ...base, raw: "correctWithHelp", result: "weak", answer: given };
	}
	if (outcome === "partly") return { ...base, raw: "partly", result: "weak", answer: given };
	if (outcome === "wrong") {
		const misconception = exerciseMisconception(answer);
		return { ...base, raw: "miss", result: "failed", answer: given, ...(misconception ? { misconception } : {}) };
	}
	return null;
}

const GRADE_RESULT: Record<Grade, EvidenceResult> = { correct: "clean", partly: "weak", wrong: "failed", dontKnow: "failed" };

const PRACTICE_RESULT: Record<(typeof PRACTICE_OUTCOMES)[number], EvidenceResult> = {
	solved: "clean",
	solvedWithHints: "weak",
	surrendered: "failed",
	movedOn: "failed",
};

/** Every graded item of one chat, in transcript order. */
export function gradedItems(chat: ChatRecord): GradedItem[] {
	const calls = toolCallsOf(chat.messages);
	const results = cleanResults(chat.messages);
	const grades = gradesOf(calls, results);
	const out: GradedItem[] = [];
	for (const call of calls) {
		const isQuiz = (QUIZ_CALLS as readonly string[]).includes(call.name);
		const isRecall = (RECALL_CALLS as readonly string[]).includes(call.name);
		if ((WORK_TOOLS as readonly string[]).includes(call.name)) {
			// Predictions are posed before the teaching: not evidence.
			if (normalizeQuizType(call.arguments.type) === "predict") continue;
			if (!isAnsweredGradable(call, results, chat.messages)) continue;
			const g = grades.get(call.id);
			if (!g) continue; // work nobody graded produces no evidence
			const last = workSubmissionsOf(chat.messages, call.id).at(-1);
			const answer = [last?.text.trim() ?? "", last?.drawingId ? "[drawing]" : ""].filter(Boolean).join(" ");
			// Help honoured (decision 24): correct at rung R2 or above is weak.
			const helped = g.grade === "correct" && g.rung !== undefined && (RUNGS as readonly string[]).indexOf(g.rung) >= HELPED_RUNG_INDEX;
			out.push({
				chatId: chat.id,
				toolCallId: call.id,
				kind: call.name as "work" | "sketch",
				at: g.at,
				raw: helped ? "correctWithHelp" : g.grade,
				result: helped ? "weak" : GRADE_RESULT[g.grade],
				...(g.note ? { note: g.note } : {}),
				...(g.misconception ? { misconception: g.misconception } : {}),
				tags: strings(call.arguments.concepts),
				question: str(call.arguments.question) ?? "",
				correct: str(call.arguments.correctAnswer) ?? "",
				answer,
			});
			continue;
		}
		if ((EXERCISE_CALLS as readonly string[]).includes(call.name)) {
			if (normalizeQuizType(call.arguments.type) === "predict") continue;
			const result = results.get(call.id);
			const answer = answerOf(result);
			if (!result || !answer) continue;
			const item = exerciseItem(chat, call, answer, result);
			if (item) out.push(item);
			continue;
		}
		if (isQuiz || isRecall) {
			// Predictions are posed before the teaching: misses are expected, not evidence.
			if (normalizeQuizType(call.arguments.type) === "predict") continue;
			const result = results.get(call.id);
			const answer = answerOf(result);
			if (!result || !answer) continue;
			if (isQuiz) {
				const item = quizItem(chat, call, answer, result);
				if (item) out.push(item);
				continue;
			}
			const g = grades.get(call.id);
			if (!g) continue; // an answer nobody graded produces no evidence
			out.push({
				chatId: chat.id,
				toolCallId: call.id,
				kind: call.name as "explain" | "recall",
				at: g.at,
				raw: g.grade,
				result: GRADE_RESULT[g.grade],
				...(g.note ? { note: g.note } : {}),
				...(g.misconception ? { misconception: g.misconception } : {}),
				tags: strings(call.arguments.concepts),
				question: str(call.arguments.question) ?? "",
				correct: str(call.arguments.correctAnswer) ?? "",
				answer: str(answer.text) ?? str(answer.other) ?? (answer.dontKnow ? "I don't know" : ""),
			});
			continue;
		}
		if (call.name === PRACTICE_CONCLUDE_TOOL) {
			const outcome = call.arguments.outcome;
			if (!(PRACTICE_OUTCOMES as readonly unknown[]).includes(outcome)) continue; // dismissed, or malformed
			const result = results.get(call.id);
			if (!result) continue;
			const problem = problemInputForConclude(chat.messages, call.id);
			const o = outcome as (typeof PRACTICE_OUTCOMES)[number];
			const verdict = str(call.arguments.verdict);
			const failed = PRACTICE_RESULT[o] === "failed";
			out.push({
				chatId: chat.id,
				toolCallId: call.id,
				kind: "practice",
				at: iso(result.timestamp),
				raw: o,
				result: PRACTICE_RESULT[o],
				...(verdict ? { note: verdict } : {}),
				...(failed && verdict ? { misconception: { term: verdict } } : {}),
				tags: strings(problem?.target),
				question: str(problem?.statement) ?? "",
				correct: "",
				answer: verdict ?? "",
			});
		}
	}
	return out;
}

const attributionKey = (chatId: string, toolCallId: string): string => `${chatId}\u0000${toolCallId}`;

/** The evidence events of all chats: one per (graded item x concept). */
export function deriveEvidence(
	chats: readonly ChatRecord[],
	attributions: readonly AttributionRow[],
	nodeIds: ReadonlySet<string>,
): EvidenceEvent[] {
	const linked = new Map<string, string[]>();
	for (const row of attributions) {
		const key = attributionKey(row.chatId, row.toolCallId);
		linked.set(key, [...(linked.get(key) ?? []), ...row.conceptIds]);
	}
	const events: EvidenceEvent[] = [];
	for (const chat of chats) {
		for (const item of gradedItems(chat)) {
			const ids = [...new Set([...item.tags, ...(linked.get(attributionKey(chat.id, item.toolCallId)) ?? [])])].filter((id) =>
				nodeIds.has(id),
			);
			for (const conceptId of ids) {
				events.push({
					at: item.at,
					conceptId,
					chatId: chat.id,
					toolCallId: item.toolCallId,
					kind: item.kind,
					raw: item.raw,
					result: item.result,
					...(item.note ? { note: item.note } : {}),
					...(item.misconception ? { misconception: item.misconception } : {}),
				});
			}
		}
	}
	return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** The graded items of a teaching chat that still need attribution: untagged
 *  (the call carried no `concepts`) and with no ledger row yet (an explicit
 *  empty row counts as attributed). Practice sessions are tagged by `target`
 *  and never attributed. */
export function unattributedItems(chat: ChatRecord, attributions: readonly AttributionRow[]): GradedItem[] {
	if (chat.kind === "practice") return [];
	const done = new Set(attributions.map((r) => attributionKey(r.chatId, r.toolCallId)));
	return gradedItems(chat).filter(
		(item) => item.kind !== "practice" && item.tags.length === 0 && !done.has(attributionKey(chat.id, item.toolCallId)),
	);
}

/** The items ready for attribution: every teacher-prose message of the chat up
 *  to and including the message carrying the item's tool call has been
 *  extracted (covered in the coverage ledger, the same selection and
 *  fingerprints extraction uses). Until then the concepts the question is
 *  about may not exist yet, so the item stays pending (no ledger row). An
 *  item with no teacher prose before it (a probe-phase question about prior
 *  knowledge) is eligible at once. */
export function eligibleForAttribution<T extends { toolCallId: string }>(
	chat: ChatRecord,
	items: readonly T[],
	coverage: readonly CoverageEntry[],
): T[] {
	const view = coverageOf(chat.messages, coverage, chat.id);
	const uncovered = view.uncovered;
	const carrier = (id: string): number =>
		chat.messages.findIndex(
			(m) => (m as { role?: string }).role === "assistant" && (m as AssistantMessage).content.some((b) => b.type === "toolCall" && b.id === id),
		);
	return items.filter((item) => {
		const idx = carrier(item.toolCallId);
		if (idx < 0) return false;
		return !uncovered.some((i) => i <= idx);
	});
}

// ─── state (derived from the evidence) ───────────────────────────────────────

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const atMs = (e: EvidenceEvent): number => {
	const t = Date.parse(e.at);
	return Number.isFinite(t) ? t : 0;
};

/** One concept's state from its own events (the foundation marker needs the others, so it is added after). */
function stateOf(conceptId: string, all: readonly EvidenceEvent[], now: Date): ConceptState {
	const history = [...all].sort((a, b) => atMs(a) - atMs(b)); // stable: ties keep ledger order
	// A session's result is its LAST event on this concept.
	const lastBySession = new Map<string, EvidenceEvent>();
	for (const e of history) lastBySession.set(e.chatId, e);
	const sessions = [...lastBySession.values()].sort((a, b) => atMs(a) - atMs(b));

	let streak = 0;
	let lastCounted: number | null = null;
	let lastClean: number | null = null;
	for (const s of sessions) {
		const t = atMs(s);
		if (s.result === "clean") {
			lastClean = t;
			if (lastCounted === null || t - lastCounted >= MIN_SPACING_HOURS * HOUR_MS) {
				streak++;
				lastCounted = t;
			}
		} else {
			streak = 0;
			lastCounted = null;
		}
	}

	const latest = sessions.at(-1);
	const state: ConceptStateName = !latest ? "not-yet-checked" : latest.result !== "clean" ? "shaky" : streak >= 2 ? "solid" : "learning";
	let nextReviewAt: string | undefined;
	if (lastCounted !== null && streak >= 1) {
		const days = REVIEW_INTERVAL_DAYS[Math.min(streak, REVIEW_INTERVAL_DAYS.length) - 1]!;
		nextReviewAt = new Date(lastCounted + days * DAY_MS).toISOString();
	}
	const due = state !== "shaky" && nextReviewAt !== undefined && now.getTime() >= Date.parse(nextReviewAt);

	// Confusions still open: those exposed after the last clean session (all of them without one).
	const open = new Map<string, ConceptState["openMisconceptions"][number]>();
	for (const e of history) {
		if (!e.misconception || (lastClean !== null && atMs(e) <= lastClean)) continue;
		open.set(e.misconception.term, { ...e.misconception, at: e.at });
	}

	return {
		conceptId,
		state,
		due,
		streak,
		...(nextReviewAt ? { nextReviewAt } : {}),
		weakFoundation: false,
		last: history.slice(-3).reverse(),
		history,
		openMisconceptions: [...open.values()],
	};
}

/**
 * The learner model at `now`: a ConceptState for every id in `nodeIds`.
 * Per concept, a session (chat) result is its last event; a clean session
 * advances the streak only at least MIN_SPACING_HOURS after the previous
 * counted one, a weak or failed one resets it (shaky). The next review is
 * REVIEW_INTERVAL_DAYS[min(streak, 4) - 1] days after the last counted
 * session. A concept has a weak foundation when a premise of a chain that
 * concludes it is shaky or due (one level; no recursion).
 */
export function deriveLearnerState(
	events: readonly EvidenceEvent[],
	chains: readonly GraphChain[],
	nodeIds: readonly string[],
	now: Date,
): LearnerSnapshot {
	const byConcept = new Map<string, EvidenceEvent[]>();
	for (const e of events) {
		const list = byConcept.get(e.conceptId) ?? [];
		list.push(e);
		byConcept.set(e.conceptId, list);
	}
	const states: Record<string, ConceptState> = {};
	for (const id of nodeIds) states[id] = stateOf(id, byConcept.get(id) ?? [], now);
	for (const c of chains) {
		const target = states[c.conclusion];
		if (!target || target.weakFoundation) continue;
		if (c.premises.some((p) => p !== c.conclusion && (states[p]?.state === "shaky" || states[p]?.due === true))) target.weakFoundation = true;
	}
	return { asOf: now.toISOString(), states };
}
