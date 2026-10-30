/**
 * THE INPUT-EVENTS CONTRACT (Wave B, owner ruling 2026-09-26: "input
 * events now, in the same pass"): POST /api/chat carries `{chatId, input}`
 * — ONE explicit event, never a client transcript. The server owns the
 * record; a send tells it what HAPPENED, not what the client's list looks
 * like. The 409 merge-retry died with the full-list body (an input event
 * retries idempotently: nothing was appended when a POST is refused).
 *
 * The four events (the complete client-originated input taxonomy):
 *   text    — a learner-authored user message (composer send, initial
 *             topic, the demo error-fix loop)
 *   answer  — the pending question's graded result (QuestionAnswerData,
 *             built client-side exactly as today; a dismissal is an answer
 *             carrying its flag). Server-side this becomes the call's
 *             native tool result — fork 1's normal agent history.
 *   continue — run the next turn on the current record (mount
 *             continuations, job-settle re-syncs: the record ends at an
 *             answered question with no teacher reaction yet).
 *   retry   — retry a failed model response (upstream issue #110), without
 *             new input. Failed attempts stay in the record; only the
 *             retry's temporary agent history omits the trailing failures.
 *
 * (The plan verdict input died 2026-09-26 with the verdict itself — the
 * learner's post-plan reply is a natural text message.)
 *
 * Server-originated delivery (the wake pipeline's steers) is NOT a client
 * input — the handler accepts it on the same path (TurnInput) so every
 * turn rides one composition.
 */

import type { QuestionAnswerData } from "./question-core.ts";
import { gradeExercise, INTERACTIVE_FORMATS, stripExpected, type InteractiveFormat } from "./exercise-core.ts";
import type { ThinkingAttempt } from "./native-messages.ts";
import type { LhMessage } from "./native-messages.ts";
import {
	activeProblemOf,
	activeWorkOf,
	concludedByDismissalPair,
	danglingQuestionOf,
	newAnswerResult,
	newHintRequest,
	nextHintNumber,
	newNextMessage,
	newProblemDismissedMarker,
	newWorkDismissedMarker,
	newWorkSubmission,
	newThinkingMessage,
	newUserMessage,
	pendingProblemDismissalOf,
} from "./native-messages.ts";
import { QUESTION_TOOLS, toolQuestionKind } from "./pending.ts";

/** One client-originated input event (the POST body's `input`). */
export type ChatInput =
	| { type: "text"; text: string }
	| { type: "answer"; toolCallId: string; answer: QuestionAnswerData }
	| { type: "continue" }
	/** The failed-turn retry (upstream issue #110): the banner's Retry button. */
	| { type: "retry" }
	/** The practice dock's two buttons (owner, 2026-10-04): the learner's
	 *  thinking on the ACTIVE problem — one lane (owner 2026-10-05):
	 *  whether it claims an answer is read from the text. One
	 *  problem may carry many submissions; each is its own turn. */
	| { type: "thinking"; problemCallId: string; text: string; attempt?: ThinkingAttempt; drawingId?: string }
	/** The practice move-on signal (owner round 16): the learner's
	 *  explicit go-ahead during the between-problems pause — the Next
	 *  chip or Enter on an empty composer. Practice sessions only, and
	 *  only with nothing active (mid-problem input rides the dock). */
	| { type: "next" }
	/** A submission on the open canvas task (work/sketch): text and/or a
	 *  drawing (decision 12 - one lane while a task is open). */
	| { type: "work-submit"; workCallId: string; text: string; drawingId?: string }
	/** The Hint button on the active canvas task or practice problem: the
	 *  agent answers with the next rung only. From the open canvas it carries
	 *  a snapshot of the canvas and his "Your thinking" draft, so the tutor can
	 *  write the hint where it is about. */
	| { type: "hint"; callId: string; drawingId?: string; text?: string };

/** A wake-pipeline steer delivery — same turn composition, server-origin.
 *  Wave C (2026-09-26): the idle wake carries EVERY queued marker as its
 *  input appends — with claimSteers deleted, the pump's wake is the only
 *  steer appender left (the in-run path hands markers to pi's own
 *  follow-up queue instead, so it never builds an input event). */
export type SteerInput = { type: "steers"; steers: LhMessage[] };

/** Every input the turn composition accepts. */
export type TurnInput = ChatInput | SteerInput;

/** The dismissal event (owner design 2026-10-03, "A2"): NEVER composes a
 *  turn — the silent route appends + persists and wakes nothing. The
 *  answer rides the event (mirroring the answer event) but must actually
 *  BE a dismissal: the silent path must never inject a live answer
 *  wake-free. Parallel question calls each get their own dismiss event;
 *  results reference their calls by id, so the appends stay independent. */
export type DismissInput =
	| { type: "dismiss"; toolCallId: string; answer: QuestionAnswerData }
	/** The problem discard (practice, owner 2026-10-04): ask-style — the
	 *  silent route appends the UI-only marker and wakes nothing; the
	 *  conclude pair rides the user's NEXT input (inputAppends). */
	| { type: "dismiss-problem"; problemCallId: string }
	/** The canvas-task discard: ask-style like dismiss-problem - the marker
	 *  closes the task, nothing wakes. */
	| { type: "dismiss-work"; workCallId: string };

function parseDrawingId(v: unknown): string {
	if (typeof v !== "string" || v.length === 0) throw new ChatInputError("drawingId must be a non-empty string");
	return v;
}

/** Parse and validate a dismissal event off a request body. */
export function parseDismissInput(input: unknown): DismissInput {
	if (typeof input !== "object" || input === null) throw new ChatInputError("input must be an object");
	const i = input as Record<string, unknown>;
	if (i.type === "dismiss-problem") {
		if (typeof i.problemCallId !== "string" || i.problemCallId.length === 0) {
			throw new ChatInputError("dismiss-problem input requires problemCallId");
		}
		return { type: "dismiss-problem", problemCallId: i.problemCallId };
	}
	if (i.type === "dismiss-work") {
		if (typeof i.workCallId !== "string" || i.workCallId.length === 0) {
			throw new ChatInputError("dismiss-work input requires workCallId");
		}
		return { type: "dismiss-work", workCallId: i.workCallId };
	}
	if (i.type !== "dismiss") throw new ChatInputError(`unknown input type: ${String(i.type)}`);
	if (typeof i.toolCallId !== "string" || i.toolCallId.length === 0) {
		throw new ChatInputError("dismiss input requires toolCallId");
	}
	const answer = i.answer as QuestionAnswerData | undefined;
	if (typeof answer !== "object" || answer === null) {
		throw new ChatInputError("dismiss input requires the dismissal answer object");
	}
	if (answer.dismissed !== true) {
		throw new ChatInputError("dismiss input's answer must be a dismissal (dismissed: true)");
	}
	return { type: "dismiss", toolCallId: i.toolCallId, answer };
}

/** A mid-turn steer (owner arc 2026-10-03): the learner's composer message
 *  for a RUNNING turn — queued on pi's steering rail (agent.steer, drained
 *  at the next response boundary INSIDE the same run). NOT a follow-up:
 *  it never extends an ended run, and it never composes a turn of its own
 *  (a send with no live turn is a plain text send, which already exists).
 *  The id is client-minted (steer_<localid>): the queued indicator keys on
 *  it, and the drain's message events upsert the real card by the same id. */
export type UserSteerInput = { type: "steer"; id: string; text: string };

/** Parse and validate a steer event off a request body. */
export function parseUserSteerInput(input: unknown): UserSteerInput {
	if (typeof input !== "object" || input === null) throw new ChatInputError("input must be an object");
	const i = input as Record<string, unknown>;
	if (i.type !== "steer") throw new ChatInputError(`unknown input type: ${String(i.type)}`);
	if (typeof i.id !== "string" || i.id.length === 0) {
		throw new ChatInputError("steer input requires a client-minted id");
	}
	if (typeof i.text !== "string" || i.text.trim().length === 0) {
		throw new ChatInputError("steer input requires non-empty text");
	}
	return { type: "steer", id: i.id, text: i.text };
}

/** The native appends a dismissal makes (pure — same orphan discipline
 *  as answers: the call must be a DANGLING question call, or — the
 *  practice variant — the ACTIVE problem). */
export function dismissAppends(record: { messages: LhMessage[] }, input: DismissInput): LhMessage[] {
	if (input.type === "dismiss-problem") {
		const active = activeProblemOf(record.messages);
		if (!active || active.toolCallId !== input.problemCallId) {
			throw new ChatInputError("dismiss-problem input targets no active problem");
		}
		return [newProblemDismissedMarker(input.problemCallId)];
	}
	if (input.type === "dismiss-work") {
		const active = activeWorkOf(record.messages);
		if (!active || active.toolCallId !== input.workCallId) {
			throw new ChatInputError("dismiss-work input targets no active canvas task");
		}
		return [newWorkDismissedMarker(input.workCallId)];
	}
	const pending = danglingQuestionOf(record.messages);
	if (!pending || pending.toolCallId !== input.toolCallId) {
		throw new ChatInputError("dismiss input targets no pending question call");
	}
	if (input.answer.kind !== toolQuestionKind(pending.tool)) {
		throw new ChatInputError("dismiss input's answer kind does not match the question");
	}
	return [newAnswerResult(input.toolCallId, pending.tool, input.answer)];
}

/** A malformed input event (the honest 400 — the orphan-trap discipline). */
export class ChatInputError extends Error {}

/** Parse and validate an input event off a request body. */
export function parseChatInput(input: unknown): ChatInput {
	if (typeof input !== "object" || input === null) throw new ChatInputError("input must be an object");
	const i = input as Record<string, unknown>;
	switch (i.type) {
		case "text":
			if (typeof i.text !== "string" || (i.text as string).trim().length === 0) {
				throw new ChatInputError("text input requires non-empty text");
			}
			return { type: "text", text: i.text };
		case "answer":
			if (typeof i.toolCallId !== "string" || i.toolCallId.length === 0) {
				throw new ChatInputError("answer input requires toolCallId");
			}
			if (typeof i.answer !== "object" || i.answer === null) {
				throw new ChatInputError("answer input requires the graded answer object");
			}
			return { type: "answer", toolCallId: i.toolCallId, answer: i.answer as QuestionAnswerData };
		case "continue":
			return { type: "continue" };
		case "retry":
			return { type: "retry" };
		case "thinking":
			if (typeof i.problemCallId !== "string" || i.problemCallId.length === 0) {
				throw new ChatInputError("thinking input requires problemCallId");
			}
			if (typeof i.text !== "string" || i.text.trim().length === 0) {
				throw new ChatInputError("thinking input requires non-empty text");
			}
			return {
				type: "thinking",
				problemCallId: i.problemCallId,
				text: i.text,
				...(i.attempt !== undefined ? { attempt: parseThinkingAttempt(i.attempt) } : {}),
				...(i.drawingId !== undefined ? { drawingId: parseDrawingId(i.drawingId) } : {}),
			};
		case "next":
			return { type: "next" };
		case "work-submit":
			if (typeof i.workCallId !== "string" || i.workCallId.length === 0) {
				throw new ChatInputError("work-submit input requires workCallId");
			}
			if (typeof i.text !== "string") throw new ChatInputError("work-submit input requires text");
			if (i.drawingId !== undefined && (typeof i.drawingId !== "string" || i.drawingId.length === 0)) {
				throw new ChatInputError("work-submit drawingId must be a non-empty string");
			}
			if (i.text.trim().length === 0 && i.drawingId === undefined) {
				throw new ChatInputError("work-submit input requires text or a drawing");
			}
			return {
				type: "work-submit",
				workCallId: i.workCallId,
				text: i.text,
				...(i.drawingId !== undefined ? { drawingId: i.drawingId as string } : {}),
			};
		case "hint":
			if (typeof i.callId !== "string" || i.callId.length === 0) {
				throw new ChatInputError("hint input requires callId");
			}
			if (i.text !== undefined && (typeof i.text !== "string" || i.text.trim().length === 0)) {
				throw new ChatInputError("hint text must be a non-empty string");
			}
			return {
				type: "hint",
				callId: i.callId,
				...(i.drawingId !== undefined ? { drawingId: parseDrawingId(i.drawingId) } : {}),
				...(i.text !== undefined ? { text: i.text as string } : {}),
			};
		default:
			throw new ChatInputError(`unknown input type: ${String(i.type)}`);
	}
}

/** Shape-check a thinking input's graded attempt (the grade itself is
 *  re-derived server-side in inputAppends; the claim only has to parse). */
function parseThinkingAttempt(raw: unknown): ThinkingAttempt {
	const a = raw as { format?: unknown; response?: unknown; verdict?: unknown } | null;
	if (typeof a !== "object" || a === null) throw new ChatInputError("thinking attempt must be an object");
	if (typeof a.format !== "string" || !(INTERACTIVE_FORMATS as readonly string[]).includes(a.format)) {
		throw new ChatInputError("thinking attempt requires a known format");
	}
	const v = a.verdict as { outcome?: unknown; items?: unknown } | null;
	if (typeof v !== "object" || v === null || typeof v.outcome !== "string" || !Array.isArray(v.items)) {
		throw new ChatInputError("thinking attempt requires the verdict object");
	}
	return { format: a.format as InteractiveFormat, response: a.response, verdict: a.verdict as ThinkingAttempt["verdict"] };
}

/** Re-grade a claimed attempt against the active problem's own spec and
 *  refuse a mismatch: the server never trusts a client verdict. Returns the
 *  server's marks-only verdict (the one that is recorded). */
function verifiedAttempt(active: { input: unknown }, attempt: ThinkingAttempt): ThinkingAttempt {
	const input = active.input as { format?: unknown; spec?: unknown } | null;
	if (!input || input.format !== attempt.format || input.spec === undefined) {
		throw new ChatInputError("thinking attempt does not match the active problem's format");
	}
	const server = gradeExercise(attempt.format, input.spec, attempt.response);
	const claim = attempt.verdict;
	const same =
		claim.outcome === server.outcome &&
		claim.earned === server.earned &&
		claim.total === server.total &&
		claim.items.length === server.items.length &&
		server.items.every((it, idx) => claim.items[idx]?.id === it.id && claim.items[idx]?.correct === it.correct);
	if (!same) throw new ChatInputError("thinking attempt's verdict does not match the response");
	return { format: attempt.format, response: attempt.response, verdict: stripExpected(server) };
}

/** What input validation needs from outside core (injected by the
 *  composition root: core never touches the stores). */
export interface InputDeps {
	/** Does a drawing submission with this id exist for the chat? Absent =
	 *  the reference is not checked (tests, bare callers). */
	drawingExists?: (chatId: string, drawingId: string) => boolean;
}

/**
 * The native appends an input event makes to the record (pure). The caller
 * persists them write-ahead; the agent's context is the record plus these.
 *
 * Answer validation is the orphan-400 discipline: the call must be a
 * DANGLING QUESTION call in the record (posed, never answered) — anything
 * else 400s honestly instead of silently interrupting a question or
 * double-answering.
 */
export function inputAppends(
	record: { id?: string; messages: LhMessage[]; kind?: string },
	input: ChatInput,
	deps: InputDeps = {},
): LhMessage[] {
	switch (input.type) {
		case "text":
			return [...dismissalConclusion(record), newUserMessage(input.text)];
		case "answer": {
			const pending = danglingQuestionOf(record.messages);
			if (!pending || pending.toolCallId !== input.toolCallId) {
				throw new ChatInputError("answer input targets no pending question call");
			}
			return [newAnswerResult(input.toolCallId, pending.tool, input.answer)];
		}
		case "continue":
			return dismissalConclusion(record);
		case "retry":
			// The input already landed write-ahead. retryDrops affects only
			// the temporary agent history: nothing new appends here.
			return [];
		case "thinking": {
			const active = activeProblemOf(record.messages);
			if (!active || active.toolCallId !== input.problemCallId) {
				throw new ChatInputError("thinking input targets no active problem");
			}
			const attempt = input.attempt ? verifiedAttempt(active, input.attempt) : undefined;
			if (input.drawingId !== undefined && deps.drawingExists && !deps.drawingExists(record.id ?? "", input.drawingId)) {
				throw new ChatInputError(`thinking input names an unknown drawing: ${input.drawingId}`);
			}
			return [
				...dismissalConclusion(record),
				newThinkingMessage(input.problemCallId, input.text, {
					...(attempt ? { attempt } : {}),
					...(input.drawingId !== undefined ? { drawingId: input.drawingId } : {}),
				}),
			];
		}
		case "next": {
			// Honest 400s, the thinking gate's discipline: the signal is a
			// between-problems affordance — practice sessions only, nothing
			// active (mid-problem input rides the dock), and the client gates
			// make violations unreachable in practice anyway.
			if (record.kind !== "practice") {
				throw new ChatInputError("next input is a practice-session affordance");
			}
			if (activeProblemOf(record.messages)) {
				throw new ChatInputError("next input requires no active problem");
			}
			return [...dismissalConclusion(record), newNextMessage()];
		}
		case "work-submit": {
			const active = activeWorkOf(record.messages);
			if (!active || active.toolCallId !== input.workCallId) {
				throw new ChatInputError("work-submit input targets no active canvas task");
			}
			// A side question (quiz/explain/exercise/ask) answers first: a
			// submission landing on a dangling call would strand it.
			if (danglingQuestionOf(record.messages) !== null) {
				throw new ChatInputError("work-submit input refused: answer the open side question first");
			}
			if (input.drawingId !== undefined && deps.drawingExists && !deps.drawingExists(record.id ?? "", input.drawingId)) {
				throw new ChatInputError(`work-submit input names an unknown drawing: ${input.drawingId}`);
			}
			return [newWorkSubmission(input.workCallId, input.text, input.drawingId)];
		}
		case "hint": {
			const work = activeWorkOf(record.messages);
			const problem = activeProblemOf(record.messages);
			if (work?.toolCallId !== input.callId && problem?.toolCallId !== input.callId) {
				throw new ChatInputError("hint input targets no active canvas task or problem");
			}
			if (danglingQuestionOf(record.messages) !== null) {
				throw new ChatInputError("hint input refused: answer the open side question first");
			}
			if (input.drawingId !== undefined && deps.drawingExists && !deps.drawingExists(record.id ?? "", input.drawingId)) {
				throw new ChatInputError(`hint input names an unknown drawing: ${input.drawingId}`);
			}
			return [
				newHintRequest(input.callId, nextHintNumber(record.messages, input.callId), {
					...(input.drawingId !== undefined ? { drawingId: input.drawingId } : {}),
					...(input.text !== undefined ? { text: input.text } : {}),
				}),
			];
		}
	}
}

/** The failure owning the ephemeral banner. Plan presentation and
 *  compaction do not resolve an error; substantive later input/output does.
 *  This is deliberately broader than Retry eligibility below. */
export function failedResponseAtEnd(messages: readonly LhMessage[]): Extract<LhMessage, { role: "assistant" }> | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "custom" && (m.customType === "plan-block" || m.customType === "compaction")) continue;
		return m.role === "assistant" && m.stopReason === "error" ? m : undefined;
	}
	return undefined;
}

/** Does the record end in a failure with input that can be retried?
 *  Aborts are deliberate stops; compaction after a failure requires new
 *  learner input rather than a retry using a changed context. */
export function endsInFailedTurn(messages: readonly LhMessage[]): boolean {
	const { ids, before } = failedTail(messages);
	return ids.size > 0 && before !== undefined && before.role !== "assistant";
}

/** The ids omitted ONLY from the retry's temporary agent history (pure).
 *  Failed attempts (including partial text and their ids) stay on disk.
 *  Pi's provider conversion already skips error/aborted responses, but
 *  continue() rejects an assistant tail BEFORE conversion. Omitting the
 *  trailing failures lets that continuation start from the saved input or
 *  completed tool results without replaying tools or resubmitting input.
 *  Plan blocks may follow the failure and stay; a later compaction blocks
 *  Retry without changing compaction itself. Honest 400s otherwise. */
export function retryDrops(messages: readonly LhMessage[]): Set<string> {
	const { ids, before } = failedTail(messages);
	if (ids.size === 0) {
		const failure = failedResponseAtEnd(messages);
		if (failure) {
			throw new ChatInputError(`${failure.errorMessage ?? "An error occurred."}\n\nThis response cannot be retried after compaction. Send a new message to continue.`);
		}
		throw new ChatInputError("retry input requires a failed turn to retry");
	}
	if (!before || before.role === "assistant") throw new ChatInputError("retry input leaves no input to continue from");
	return ids;
}

/** Walk back over failed assistants and UI-only plan blocks. A compaction
 *  is a boundary, not a marker Retry may cross. A failure AFTER a compaction
 *  can still retry: that compacted context was already its starting state. */
function failedTail(messages: readonly LhMessage[]): { ids: Set<string>; before: LhMessage | undefined } {
	const ids = new Set<string>();
	let i = messages.length - 1;
	for (; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "assistant" && m.stopReason === "error") ids.add(m.id);
		else if (!(m.role === "custom" && m.customType === "plan-block")) break;
	}
	return { ids, before: messages[i] };
}

/** The deferred conclude synthesis (owner ruling, 2026-10-04): a
 *  problem-dismissal marker waits for the user's next input — the pair
 *  (synthetic conclude call + ack) rides ahead of it, so the agent reads
 *  the dismissal through its own vocabulary and the slot frees. Pure;
 *  empty when nothing dismissals pend. */
function dismissalConclusion(record: { messages: LhMessage[] }): LhMessage[] {
	const problemCallId = pendingProblemDismissalOf(record.messages);
	return problemCallId ? concludedByDismissalPair(problemCallId) : [];
}

/** Is this tool name a question tool (dock-owned, answer-gated)? */
export function isQuestionTool(name: string): boolean {
	return (QUESTION_TOOLS as readonly string[]).includes(name);
}
