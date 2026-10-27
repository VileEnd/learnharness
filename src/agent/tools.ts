import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, questionResult, serverExecute } from "./tool-execute.ts";
import {
	exerciseInputBase,
	exerciseInputObject,
	askInputSchema,
	askOptionProblems,
	explainInputBase,
	explainInputObject,
	explainInputProblems,
	parseOptionsIfString,
	probeQuizInputSchema,
	quizInputObject,
	quizInputProblems,
} from "../core/question-core.ts";
import { exerciseSpecProblems, hintLeaks, type InteractiveFormat } from "../core/exercise-core.ts";
import type { QuizMechanic } from "../core/settings.ts";
import { resolveQuizMechanic } from "../core/settings-resolution.ts";
import { filterEnabledTools, type EnabledTools } from "../core/pending.ts";
import { resolveTargetId } from "../core/chains.ts";
import { visibleTeachingSinceLastInput } from "../core/native-messages.ts";
import { ungradedAnsweredRecalls } from "../core/learner.ts";
import type { GraphNode, JobRecord } from "../core/contracts.ts";
import type { ChatStore, JobStore } from "../core/ports.ts";
import { jobTools, type DemoInput, type ResearchInput, type VisualInput } from "./tools/jobs.ts";
import { planTools, type PlanToolContext } from "./tools/plan.ts";
import { probeDoneTool, type ProbeDoneContext } from "./tools/probe.ts";
import { documentTools, type DocumentToolDeps } from "./tools/documents.ts";
import { readToolFor } from "./tools/read.ts";
import { lsToolFor } from "./tools/ls.ts";
import { findToolFor } from "./tools/find.ts";
import { grepToolFor } from "./tools/grep.ts";
import { gradeTool } from "./tools/grade.ts";
import { healToolRecord } from "./tools/heal.ts";

export { jobTools };
export type { ProbeDoneContext } from "./tools/probe.ts";

/**
 * The agent-split tool composition (docs/probe-teach-split.md §1): the
 * PROBER and the TEACHER are different agents with different tool sets.
 * The question tools share a NAME but are genuinely DIFFERENT tools —
 * the prober's quiz has NO nodeId field at all (its declaration is built
 * from quizInputBase; the model's schema never mentions nodeId), the
 * teacher's carries the validated position field.
 *
 * - Question tools (quiz / ask_user_question): CLIENT-ANSWERED. Their
 *   execute validates the authoring refinements (the cross-field rules no
 *   schema carries — quizInputProblems / askOptionProblems; a failure
 *   throws ToolInputError, which pi's loop converts to an error tool
 *   result the model retries on), then returns the synthetic
 *   "question posed" placeholder (questionResult: terminate: true — the
 *   turn ends; the call streams to the browser in `input-available`
 *   state; the learner answers in the dock; the client grades and sends
 *   the verdict with addToolOutput). Input schemas live in
 *   core/question-core. Question tools opt into SEQUENTIAL execution so
 *   parallel calls resolve in the model's call order (the dock's subject
 *   can never flip mid-turn).
 * - probe_done (src/agent/tools/probe.ts): SERVER-SIDE seam tool.
 * - planTools (src/agent/tools/plan.ts): SERVER-SIDE — author-once
 *   plan_init. Teacher only.
 * - jobTools (src/agent/tools/jobs.ts): SERVER-EXECUTED dispatch. Teacher
 *   only.
 */

/** GLM wobble guard (owner-approved, 2026-09-26): models sometimes emit
 *  `options` as a JSON-encoded string instead of an array; pi runs this
 *  BEFORE schema validation, so a double-encoded call lands instead of
 *  bouncing back as a validation error + wasted retry turn. NOTE: pi
 *  persists the tool call with its RAW arguments — the client coerces
 *  again in normalizeOptions (question-core), the same parseOptionsIfString.
 *  Anything unparseable passes through untouched: validation then reports
 *  honestly and the agent retries with a real error to learn from. */
/** The whole-graph node list the `concepts` tag validates against, read
 *  fresh per call (the practice tools' `graphNodes` idiom). Absent (tests,
 *  graph off) = no validation. */
export type ConceptNodes = () => ReadonlyArray<Pick<GraphNode, "id" | "name">>;

function prepareQuestionArgumentsFor<T extends object>(graphNodes?: ConceptNodes): (args: unknown) => T {
	return (args: unknown): T => {
		if (!(args && typeof args === "object" && !Array.isArray(args))) return args as T;
		let out = args as { options?: unknown; concepts?: unknown };
		if (typeof out.options === "string") {
			const parsed = parseOptionsIfString(out.options);
			if (parsed !== out.options) out = { ...out, options: parsed };
		}
		// CONCEPTS (mirrors the practice `target` seam): an explicit empty list
		// is healed AWAY (the record's canonical form is tagged-or-absent); names
		// silently become ids; unresolvable strings pass through for execute to
		// reject.
		if (Array.isArray(out.concepts)) {
			const concepts: unknown[] = out.concepts;
			if (concepts.length === 0) {
				out = { ...out, concepts: undefined };
			} else if (graphNodes) {
				const list = graphNodes();
				const normalized = concepts.map((c) => (typeof c === "string" ? (resolveTargetId(c, list) ?? c) : c));
				if (normalized.some((c, i) => c !== concepts[i])) out = { ...out, concepts: normalized };
			}
		}
		return out as T;
	};
}
function prepareQuestionArguments<T extends object>(args: unknown): T {
	return prepareQuestionArgumentsFor<T>()(args);
}

/** Call-time validation of a question's `concepts` tag (the `target` idiom):
 *  every id must be a graph node. Empty result = valid or nothing to check. */
export function conceptsProblems(graphNodes: ConceptNodes | undefined, concepts: readonly string[] | undefined): string[] {
	if (!graphNodes || !concepts || concepts.length === 0) return [];
	const known = new Set(graphNodes().map((n) => n.id));
	return concepts
		.filter((id) => !known.has(id))
		.map((id) => `concepts: unknown id "${id}" - copy ids from the concept files' frontmatter`);
}

export const askUserQuestionTool: AgentTool<typeof askInputSchema> = {
	name: "ask_user_question",
	label: "ask_user_question",
	description:
		"Ask the learner a single question and pause until they answer. NOT graded — there is no correct answer. " +
		"Use when requirements are ambiguous, preferences are needed, a decision would materially affect the lesson, " +
		"or you need an open-ended response. ONE question per turn: call a single ask_user_question, then end your " +
		"turn — his answer determines the next.",
	parameters: askInputSchema,
	prepareArguments: prepareQuestionArguments,
	executionMode: "sequential",
	execute: async (_toolCallId, input) => {
		const problems = askOptionProblems(input.options ?? []);
		if (problems.length > 0) return invalidInputResult("ask_user_question", problems);
		return questionResult();
	},
};

// ─── the question tools ───────────────────────────────────────────────────────
//
// MECHANICAL DESCRIPTIONS ONLY (owner 2026-10-03): a tool's description
// carries what the tool DOES and how its fields work — nothing about what
// the questions should BE. The craft (option-building, free-recall
// grading, question roles) lives in the system prompt — a single-sourced
// chunk both agents compose (prompts/shared/20-question-tools.md and the
// teacher's question fragments), reversing the 2026-09-27 placement now
// that the question family has grown (predict/check roles, future
// quiz variants): duplicates stay honest by sharing SCHEMA ATOMS
// (question-core) + PROMPT CHUNKS, and each tool declares only its
// mechanical delta.
//
// ONE sanctioned exception (owner, 2026-10-12): each quiz tool's
// description ends with a COMPLETE example call — compact, phase-correct
// (probe carries no phase metadata; quiz leads with type+nodeId), doubling
// as the JSON-escaping exemplar (LaTeX backslashes double inside JSON
// strings). Placement ruling: WITH THE TOOL, beside its exact schema — a
// shared-prompt example is phase-ambiguous (the models fumbled exactly
// these metadata fields), per-agent prompt copies would drift. Serialized
// from ONE canonical body so the variants cannot disagree; craft doctrine
// stays in the prompts.

/** The canonical example body (owner-approved content, 2026-10-12): a
 *  compact applied question whose fields exercise the escaping hazards —
 *  braced commands (\frac, \cos), inline and display math, newlines —
 *  while doubling as an exemplar of good craft: uniform options, stable
 *  values, reasoning (explanation) committed before correctAnswer.
 *  JSON.stringify renders the wire text, so the escaping the model sees
 *  is by construction the correct one. Exported for the description pins. */
export const quizExampleBody = {
	question: "A signal is $y=\\sin(2x)$ and $\\frac{dx}{dt}=3$. What is $\\frac{dy}{dt}$?",
	options: [
		{ label: "$6\\cos(2x)$", value: "a" },
		{ label: "$2\\cos(2x)$", value: "b" },
		{ label: "$3\\cos(2x)$", value: "c" },
	],
	explanation:
		"The phase changes twice as fast as $x$; multiply by the sine's slope:\n$$\n\\frac{dy}{dt}=\\cos(2x)\\cdot2\\cdot3=6\\cos(2x)\n$$",
	correctAnswer: "a",
};

/** The quiz mechanics every variant shares; `delta` appends the variant's
 *  own fields (its NAME among them — the probe-phase tools self-reference
 *  as probe/recall, owner 2026-10-09). All mechanics, zero doctrine — plus
 *  the one sanctioned example (above). */
function quizDescription(delta: { name: "quiz" | "probe"; nodeId: boolean; types: boolean }): string {
	const base =
		"Ask the learner a GRADED question with a known correct answer, then instantly grade and give feedback. " +
		"Unlike ask_user_question (which collects preferences/decisions with no right answer), " +
		delta.name +
		" always has a " +
		"correct answer supplied by you, marks the learner's selection right/wrong, reveals the correct answer, and " +
		"can show an explanation. Options-only: single-select or multi-select, plus an automatic 'I don't know' " +
		"choice so the learner can signal a genuine gap instead of guessing. An always-present optional thinking " +
		"field lets the learner attach his reasoning to ANY answer; it reaches you only when non-empty. " +
		"No free-text answers — for non-graded questions use ask_user_question instead. " +
		(delta.types
			? "Every call declares `type` — the question's role in the teaching cycle; the field's own description says when each kind fires. "
			: "") +
		(delta.nodeId
			? "Set `nodeId` (required) to the plan node this question is about — validated at call time against the session's plan map. For off-map checks use ask_user_question. "
			: "") +
		"ONE question per turn: call a single " +
		delta.name +
		", then end your turn — his answer determines the next.";
	// Phase-correct shape: the teach example LEADS with the required pair
	// (type, nodeId — the 2026-10-09 drop-order ruling); the probe example
	// carries no phase metadata at all, exactly like the probe schema.
	const example = delta.nodeId ? { type: "check" as const, nodeId: "chain-rule", ...quizExampleBody } : quizExampleBody;
	return (
		base +
		"\nExample arguments — copy the escaping exactly: inside JSON strings a LaTeX backslash is \\\\ and a newline is \\n.\n```json\n" +
		JSON.stringify(example, null, 2) +
		"\n```" +
		(delta.nodeId ? " The example's nodeId is illustrative — copy an exact id from this session's plan_init." : "")
	);
}

/** The explain mechanics (free-recall quizzing): the commitment rule is
 *  the GRADING CONTRACT — mechanics, not doctrine. The softer doctrine
 *  (near-miss reading, genuine gaps) lives in the shared prompt chunk.
 *  `name`: the teach tool self-references as explain, the probe variant
 *  as recall (owner 2026-10-09). */
function explainDescription(name: "explain" | "recall", nodeId: boolean): string {
	return (
		"Ask the learner to EXPLAIN something in his own words — a graded check with NO options: he types a free-text " +
		"answer. Unlike ask_user_question (no right answer), " +
		name +
		" always has one. THE COMMITMENT RULE: " +
		"correctAnswer is the FULL correct answer in your own words, reasoning included, COMMITTED before he ever " +
		"sees the question. When his answer returns, grade it strictly against the commitment — never revise it " +
		"after seeing his words. He sees the committed answer on submit. " +
		(nodeId
			? "Set `nodeId` (required) to the plan node this question is about — validated at call time against the session's plan map. "
			: "") +
		"ONE question per turn: call a single " + name + ", then end your turn — his answer determines the next."
	);
}

/** The prober's multiple-choice quizzing tool — named `probe`, not
 *  `quiz` (owner, 2026-10-09): the probe and teach schemas differ
 *  (neither `type` nor `nodeId` exists while probing), and a shared name
 *  invited the model to carry its probe-phase call shape into teaching
 *  — the first teach quiz after plan_init dropped `nodeId` on exactly
 *  that habit (the tools_fails_2 incident). Distinct names make the
 *  phase boundary visible in the transcript itself: history written by
 *  `probe` never lies about what `quiz` requires. */
export function probeQuizToolFor(ctx: { graphNodes?: ConceptNodes } = {}): AgentTool<typeof probeQuizInputSchema> {
	return {
		name: "probe",
		label: "probe",
		description: quizDescription({ name: "probe", nodeId: false, types: false }),
		parameters: probeQuizInputSchema,
		prepareArguments: prepareQuestionArgumentsFor(ctx.graphNodes),
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = [...quizInputProblems(input), ...conceptsProblems(ctx.graphNodes, input.concepts)];
			if (problems.length > 0) return invalidInputResult("probe", problems);
			return questionResult();
		},
	};
}
/** The validation-free probe quiz (no graph wired: tests). */
export const probeQuizTool = probeQuizToolFor();

/** The teacher's free-recall variant (nodeId-validated, same seam as the
 *  teach quiz — phases/plan recognize BOTH tool names). */
export function teachExplainToolFor(
	ctx: Pick<PlanToolContext, "chatId" | "chatStore"> & { graphNodes?: ConceptNodes; turn?: TeachTurnView },
): AgentTool<typeof explainInputObject> {
	const guard = teachGuardFor(ctx.turn);
	return {
		name: "explain",
		label: "explain",
		description: explainDescription("explain", true),
		parameters: explainInputObject,
		prepareArguments: prepareQuestionArgumentsFor(ctx.graphNodes),
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = [...explainInputProblems(input), ...conceptsProblems(ctx.graphNodes, input.concepts)];
			const nodeIdProblemText = nodeIdProblem(ctx, input.nodeId);
			if (nodeIdProblemText) problems.push(nodeIdProblemText);
			if (problems.length > 0) return invalidInputResult("explain", problems);
			const refusal = guard("explain", input.type);
			if (refusal) return invalidInputResult("explain", [refusal]);
			return questionResult();
		},
	};
}

/** The prober's free-recall variant (no nodeId — same pattern as the
 *  probe quiz). */
/** The prober's free-recall variant — named `recall`, not `explain`
 *  (owner, 2026-10-09), for the same phase-boundary reason as `probe`:
 *  the teach explain adds `type` and `nodeId`; a shared name carried the
 *  probe call shape into teaching. Old probe-phase records keep the
 *  `explain` name and parse identically (the display seam accepts
 *  both). */
export function probeExplainToolFor(ctx: { graphNodes?: ConceptNodes } = {}): AgentTool<typeof explainInputBase> {
	return {
		name: "recall",
		label: "recall",
		description: explainDescription("recall", false),
		parameters: explainInputBase,
		prepareArguments: prepareQuestionArgumentsFor(ctx.graphNodes),
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = [...explainInputProblems(input), ...conceptsProblems(ctx.graphNodes, input.concepts)];
			if (problems.length > 0) return invalidInputResult("recall", problems);
			return questionResult();
		},
	};
}
/** The validation-free recall tool (no graph wired: tests). */
export const probeExplainTool = probeExplainToolFor();

// ─── the exercise / assess tools (interactive generative formats) ────────────
//
// Same family as quiz/explain: CLIENT-ANSWERED (the browser grades locally
// against the committed spec and returns the verdict as the tool output).
// Mechanical description only: what each format's `spec` carries.

/** Per-format `spec` field docs (mechanics only), listed for the enabled formats. */
export const FORMAT_SPEC_DOCS: Partial<Record<InteractiveFormat, string>> = {
	numeric:
		'numeric: {answer: string, mode: "number"|"expression", variables?: string[] (every letter an expression answer uses), ' +
		"tolerance?: {abs?, rel?}, unit?: string}. One typed value.",
	blanks:
		"blanks: {text: string containing {{id}} placeholders, blanks: [{id, accept: string[], mode?: \"text\"|\"number\"|\"expression\", " +
		"caseSensitive?, variables?}]}. Fill-in-the-blank typed answers, no word bank.",
	table:
		'table: {columns: string[], rows: [{cells: ({given: string} | {id, accept: string[], mode?: "text"|"number"|"expression"|"bit", variables?})[]}]}. ' +
		"Fixed cells are `given`; editable cells carry an id and the accepted values. At least one editable cell.",
	multipart:
		'multipart: {parts: [{id, label, format: "numeric"|"blanks"|"table", spec, weight?}]} with 2-6 parts, no nesting; each part\'s spec follows its own format.',
};

/** The spec docs for the enabled formats, joined (shared with the practice `problem` tool). */
export function formatSpecDocs(formats: readonly InteractiveFormat[]): string {
	return formats.map((f) => FORMAT_SPEC_DOCS[f]).filter((d): d is string => d !== undefined).join(" ");
}

function exerciseDescription(name: "exercise" | "assess", formats: readonly InteractiveFormat[], nodeId: boolean): string {
	return (
		"Pose an interactive EXERCISE the learner solves by producing an answer in a structured widget, then grade it. " +
		"The browser grades locally against your `spec` (the answer key; hidden from the learner until they are done or give up). " +
		"The learner can Check as many times as they like — each Check shows per-item right/wrong marks, never the key — and " +
		"may reveal your `hints` one at a time, or give up. `hints` is 2 or 3 escalating strings, and no hint may contain an accepted answer. " +
		"Write `explanation` BEFORE `spec`. The result you receive is the outcome, score, per-item marks, attempts, hints used and any give-up. " +
		(nodeId
			? "Every call declares `type` (the question's role in the teaching cycle) and `nodeId` (required, the plan node this exercise is about — validated at call time). "
			: "") +
		"Set `requireThinking` to true to require the learner's written thinking before they can submit. " +
		"ONE exercise per turn: call a single " +
		name +
		", then end your turn. The `format` field takes one of: " +
		formats.join(", ") +
		". The `spec` fields by format: " +
		formatSpecDocs(formats)
	);
}

/** Cross-field authoring checks shared by exercise/assess (spec, hints, concepts). */
function exerciseProblems(
	input: { format: string; spec: unknown; hints: readonly string[] },
	graphNodes: ConceptNodes | undefined,
	concepts: readonly string[] | undefined,
): string[] {
	const problems = exerciseSpecProblems(input.format, input.spec).map((p) => `spec: ${p}`);
	if (input.hints.length < 2 || input.hints.length > 3) {
		problems.push(`hints: provide 2 or 3 escalating hints (got ${input.hints.length}).`);
	}
	for (const leaked of hintLeaks(input.format, input.spec, input.hints)) {
		problems.push(`hints: a hint contains the accepted answer "${leaked}" - hints may nudge but never state the answer.`);
	}
	problems.push(...conceptsProblems(graphNodes, concepts));
	return problems;
}

/** `format` is a literal union of the ENABLED formats; `spec` an open object. */
function exerciseFormatField(formats: readonly InteractiveFormat[]) {
	return Type.Union(
		formats.map((f) => Type.Literal(f)),
		{ description: "REQUIRED — which interactive format the learner works in (bare word, no quotes)." },
	);
}

/** The teacher's exercise tool: nodeId-validated like the teach quiz. */
export function teachExerciseToolFor(
	ctx: Pick<PlanToolContext, "chatId" | "chatStore"> & { graphNodes?: ConceptNodes },
	formats: readonly InteractiveFormat[],
) {
	const parameters = Type.Object({ ...exerciseInputObject.properties, format: exerciseFormatField(formats) });
	const tool: AgentTool<typeof parameters> = {
		name: "exercise",
		label: "exercise",
		description: exerciseDescription("exercise", formats, true),
		parameters,
		prepareArguments: prepareQuestionArgumentsFor(ctx.graphNodes),
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = exerciseProblems(input, ctx.graphNodes, input.concepts);
			const nodeIdProblemText = nodeIdProblem(ctx, input.nodeId);
			if (nodeIdProblemText) problems.push(nodeIdProblemText);
			if (problems.length > 0) return invalidInputResult("exercise", problems);
			return questionResult();
		},
	};
	return tool;
}

/** The prober's exercise tool - named `assess`; no `type`, no `nodeId`. */
export function probeExerciseToolFor(ctx: { graphNodes?: ConceptNodes } = {}, formats: readonly InteractiveFormat[] = []) {
	const parameters = Type.Object({ ...exerciseInputBase.properties, format: exerciseFormatField(formats) });
	const tool: AgentTool<typeof parameters> = {
		name: "assess",
		label: "assess",
		description: exerciseDescription("assess", formats, false),
		parameters,
		prepareArguments: prepareQuestionArgumentsFor(ctx.graphNodes),
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = exerciseProblems(input, ctx.graphNodes, input.concepts);
			if (problems.length > 0) return invalidInputResult("assess", problems);
			return questionResult();
		},
	};
	return tool;
}

/** The prober's registry context: the probe's own needs (probe_done —
 *  ProbeDoneContext) PLUS the job-dispatch wiring, since the owner ruling
 *  (2026-09-20) puts research in the probe phase's registry too. */
export interface ProberToolContext extends ProbeDoneContext {
	/** Creates the job record (deduped by toolCallId). */
	jobStore: JobStore;
	/** Fire the background runner for a freshly created job. */
	spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput) => void;
	/** Retained search-status seam; research dispatch is available keylessly. */
	searchAvailable?: () => boolean;
	/** The document search tool (PR I): present = search_documents is
	 *  registered. The composition root passes it only when
	 *  documentToolsEnabled(effective). */
	documents?: DocumentToolDeps;
	/** The library root the read/ls/find/grep tools are confined to. */
	libraryRoot: string;
	/** Runs before every library tool call (the bundle freshness hook). */
	libraryBeforeAccess?: () => Promise<void>;
	/** The whole-graph node list the questions' `concepts` tags validate
	 *  against (read fresh per call). Absent = tags are not validated. */
	graphNodes?: ConceptNodes;
	/** The resolved quizzing mechanic. Absent = derived from `enabled`
	 *  (legacy tools.explain), else Mixed. */
	quizMechanic?: QuizMechanic;
	/** The interactive formats switched on (agent.formats). Empty/absent = no `assess` tool. */
	formats?: InteractiveFormat[];
}

/** The prober's tool set: probe quiz (no nodeId) + ask + the learner-fs
 *  set + probe_done + the two phase-omnipresent job dispatch tools +
 *  (wave 7, gated) the graph-map reader. `enabled` is the resolved
 *  settings seam (core/pending.ts): any tool explicitly false is dropped
 *  from the registry. probe_done stays always-on regardless — it is how
 *  the phase ENDS; a prober that can never conclude is a lockout. */
export function createProberTools(
	ctx: ProberToolContext,
	enabled?: EnabledTools,
): Record<string, AgentTool<any>> {
	// probe_done is re-added AFTER the filter, always-on by construction — it
	// is how the phase ENDS; a prober that can never conclude is a lockout.
	const done = probeDoneTool(ctx);
	// The job tools build over the SAME context/gates as the teacher's
	// (one builder, one gating semantic); the prober carries a SUBSET:
	const jobs = jobTools({
		chatId: ctx.chatId,
		jobStore: ctx.jobStore,
		spawn: ctx.spawn,
		searchAvailable: ctx.searchAvailable,
	});
	// Quizzing mechanics (owner 2026-09-27): free-recall swaps the probe
	// quiz for the probe explain; Mixed arms both. Whichever the settings
	// resolve to. ask stays always-on. The registry keys are the
	// PHASE names (probe/recall, owner 2026-10-09) — distinct from the
	// teach tools so the schema boundary is visible to the model.
	const mechanics = ctx.quizMechanic ?? resolveQuizMechanic({ tools: enabled as Record<string, boolean> });
	// The armed quizzing tool, widened to the registry's heterogeneous
	// AgentTool record BEFORE the filter (a conditional spread of two
	// differently-typed literals makes the whole object's type a union —
	// unusable as Record<string, AgentTool<any>> downstream).
	const quizzing: Record<string, AgentTool<any>> =
		{
			...(mechanics !== "free" ? { probe: probeQuizToolFor({ graphNodes: ctx.graphNodes }) } : {}),
			...(mechanics !== "choice" ? { recall: probeExplainToolFor({ graphNodes: ctx.graphNodes }) } : {}),
			...((ctx.formats ?? []).length > 0 ? { assess: probeExerciseToolFor({ graphNodes: ctx.graphNodes }, ctx.formats!) } : {}),
		};
	// healToolRecord (owner, 2026-10-09 — the whitehead generalization):
	// the standard argument heal over the WHOLE registry — every tool,
	// not just the one the latest wobble incident landed on.
	return healToolRecord({
		...filterEnabledTools(
			{
				...quizzing,
				ask_user_question: askUserQuestionTool,
				// The learner-filesystem set is always-on (user-decided 2026-09,
				// sources v1): the prober inspects and LOCATES learner-referenced
				// files while assessing the edge. Read-only by construction.
				read: readToolFor(ctx.libraryRoot, { beforeAccess: ctx.libraryBeforeAccess }),
				ls: lsToolFor(ctx.libraryRoot, { beforeAccess: ctx.libraryBeforeAccess }),
				find: findToolFor(ctx.libraryRoot, { beforeAccess: ctx.libraryBeforeAccess }),
				grep: grepToolFor(ctx.libraryRoot, { beforeAccess: ctx.libraryBeforeAccess }),
				// Job dispatch in the probe phase (owner ruling, 2026-09-20):
				// research is ALWAYS available in every phase — the
				// prober can verify facts while assessing.
				// demo/visual stay teach-phase-only (they need the lesson's plan
				// context). Same user-toggle filtering as the teacher; research
				// remains available without a search-provider key.
				...(jobs.research ? { research: jobs.research } : {}),
				...(ctx.documents ? documentTools(ctx.documents) : {}),
				...gradeFor(ctx, mechanics),
				...done,
			},
				withoutMechanics(enabled),
			),
			...done,
		});
}

// ─── the teacher's question tools (quiz carries the position field) ──────────


/** The in-flight turn as the teach guard sees it. SEAM CHOICE (V2): the tools
 *  are built BEFORE the Agent, so the teacher agent hands them this late-bound
 *  view; it reads the agent's own message state (history + this turn's
 *  messages, tool results included) at execute time. Least invasive: no new
 *  gate threaded through the handler, and tests without it are unguarded. */
export interface TeachTurnView {
	/** History plus the in-flight turn's messages. */
	messages: () => readonly unknown[];
	/** Whether send_to_user is registered for this turn's model. */
	hasSendToUser: () => boolean;
}

/** One guard per registry (= per turn): refuses a `check` question when no
 *  visible teaching reached the learner since his last input. A repeat
 *  refusal of the same tool is allowed on the third attempt (warned), so a
 *  stubborn model can never loop forever. Predictions are exempt. */
const GUARD_MAX_REFUSALS = 2;
export function teachGuardFor(view: TeachTurnView | undefined) {
	const refusals = new Map<string, number>();
	return (tool: "quiz" | "explain", type: string | undefined): string | null => {
		if (!view || type !== "check") return null;
		if (visibleTeachingSinceLastInput(view.messages(), [])) return null;
		const n = refusals.get(tool) ?? 0;
		if (n >= GUARD_MAX_REFUSALS) {
			console.warn(`[teach-guard] ${tool}: check allowed after ${n} refusals with no visible teaching`);
			return null;
		}
		refusals.set(tool, n + 1);
		return (
			"No visible teaching reached the learner before this check. " +
			(view.hasSendToUser()
				? "Text you write after a tool result may not be delivered; send your teaching with `send_to_user`, then pose the check."
				: "Write your teaching as normal text first, then pose the check.")
		);
	};
}

/** The nodeId-against-live-tree check the teacher's quiz chains after the
 *  shared authoring contract (the old superRefine, verbatim). */
function nodeIdProblem(ctx: Pick<PlanToolContext, "chatId" | "chatStore">, nodeId: string): string | null {
	const record = ctx.chatStore.getChat(ctx.chatId);
	const known = record?.tree?.nodes.map((n) => n.id) ?? [];
	if (!known.includes(nodeId)) {
		return (
			`nodeId "${nodeId}" matches no node in this session's plan map. ` +
			(known.length > 0
				? `Copy one of your plan_init slugs exactly (${known.slice(0, 5).join(", ")}${known.length > 5 ? ", …" : ""}).`
				: "No plan map exists yet — call plan_init before posing quizzes.")
		);
	}
	return null;
}

/** Build the teach-side quiz tool for one request (exported for tests): the authoring contract
 *  + the per-session plan-nodeId validation (both run in execute — the
 *  grading contract is untouched). Reads the LIVE chat record, so rewrites
 *  mid-turn are honored, and with no tree yet every nodeId is rejected.
 *  nodeId is REQUIRED (owner ruling 2026-09-26): the untagged ad-hoc quiz is
 *  gone — off-map checks route through ask_user_question, and the teach
 *  seam (first tagged quiz) is structurally guaranteed. */
export function teachQuizToolFor(
	ctx: Pick<PlanToolContext, "chatId" | "chatStore"> & { graphNodes?: ConceptNodes; turn?: TeachTurnView },
): AgentTool<typeof quizInputObject> {
	const guard = teachGuardFor(ctx.turn);
	return {
		name: "quiz",
		label: "quiz",
		description: quizDescription({ name: "quiz", nodeId: true, types: true }),
		parameters: quizInputObject,
		prepareArguments: prepareQuestionArgumentsFor(ctx.graphNodes),
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = [...quizInputProblems(input), ...conceptsProblems(ctx.graphNodes, input.concepts)];
			const nodeIdProblemText = nodeIdProblem(ctx, input.nodeId);
			if (nodeIdProblemText) problems.push(nodeIdProblemText);
			if (problems.length > 0) return invalidInputResult("quiz", problems);
			const refusal = guard("quiz", input.type);
			if (refusal) return invalidInputResult("quiz", [refusal]);
			return questionResult();
		},
	};
}

export interface TeacherToolContext extends PlanToolContext {
	/** The in-flight turn's view for the teach-phase guard (see TeachTurnView).
	 *  Absent = unguarded. */
	turn?: TeachTurnView;
	/** Job-tool wiring (sub-agent dispatch): the job store + the runner's
	 *  spawn seam. The composition root injects both. */
	jobStore: JobStore;
	/** Fire the background runner for a freshly created job. The tool input
	 *  rides along — the spawn fires mid-stream, before the tool part is
	 *  persisted to the transcript (a transcript scan would race it). */
	spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput) => void;
	/** Retained search-status seam; research dispatch is available keylessly. */
	searchAvailable?: () => boolean;
	/** The document library tools (PR I), gated like the prober's. */
	documents?: DocumentToolDeps;
	/** The library root the read/ls/find/grep tools are confined to. */
	libraryRoot: string;
	/** Runs before every library tool call (the bundle freshness hook). */
	libraryBeforeAccess?: () => Promise<void>;
	/** The whole-graph node list the questions' `concepts` tags validate
	 *  against (read fresh per call). Absent = tags are not validated. */
	graphNodes?: ConceptNodes;
	/** The resolved quizzing mechanic. Absent = derived from `enabled`
	 *  (legacy tools.explain), else Mixed. */
	quizMechanic?: QuizMechanic;
	/** The interactive formats switched on (agent.formats). Empty/absent = no `exercise` tool. */
	formats?: InteractiveFormat[];
}

/**
 * Per-request teacher tool registry: teach questions (validated nodeId) +
 * plan tools + job tools, all closing over the ctx.
 *
 * `enabled` is the resolved settings seam (core/pending.ts EnabledTools —
 * Platform's chat-handler wiring passes it through from settings). Today
 * only the sub-agent tools (research/demo/visual) are user-toggleable, but
 * the filtering is GENERIC: any name explicitly false is dropped, so
 * future toggleables (question-tool variants, …) need no change here.
 * Absent/undefined = enabled — tests and old records see today's set.
 */
/** Strip the mechanics keys so filterEnabledTools can never drop the
 *  quizzing tools (resolveQuizMechanic is their only switch; the 2026-09-19
 *  wedge ruling stands — a quiz-less prober collapses its assessment flow). */
function withoutMechanics(enabled?: EnabledTools): EnabledTools | undefined {
	if (!enabled) return undefined;
	const { explain: _e, quiz: _q, ...rest } = enabled;
	return rest;
}

/** The `grade` tool's registration law: present whenever the free-recall
 *  or mixed mechanic is armed, OR an answered explain/recall in the record still
 *  waits for its grade (the mechanic may have been switched off mid-session,
 *  and a pending answer must stay gradeable). Read from the live record at
 *  registry construction (one registry per turn). */
function gradeFor(
	ctx: { chatId: string; chatStore: ChatStore },
	mechanics: QuizMechanic,
): Record<string, AgentTool<any>> {
	if (mechanics === "choice") {
		// Optional chain: partial test contexts carry no store (no record = nothing pending).
		const record = ctx.chatStore?.getChat?.(ctx.chatId);
		if (!record || ungradedAnsweredRecalls(record.messages).length === 0) return {};
	}
	return { grade: gradeTool(ctx) };
}

export function createTeacherTools(
	ctx: TeacherToolContext,
	enabled?: EnabledTools,
): Record<string, AgentTool<any>> {
	// Quizzing mechanics (owner 2026-09-27): free-recall swaps the teach
	// quiz for the teach explain; Mixed arms both. Whichever the settings
	// resolve to. ask stays always-on.
	const mechanics = ctx.quizMechanic ?? resolveQuizMechanic({ tools: enabled as Record<string, boolean> });
	// Same widening as the prober's (see above) — the conditional spread of
	// two differently-typed literals collapses into an unusable union type.
	const quizzing: Record<string, AgentTool<any>> =
		{
			...(mechanics !== "free" ? { quiz: teachQuizToolFor(ctx) } : {}),
			...(mechanics !== "choice" ? { explain: teachExplainToolFor(ctx) } : {}),
			...((ctx.formats ?? []).length > 0 ? { exercise: teachExerciseToolFor(ctx, ctx.formats!) } : {}),
		};
	// healToolRecord — same standard as the prober's registry (above).
	return healToolRecord(
		filterEnabledTools(
			{
			...quizzing,
			ask_user_question: askUserQuestionTool,
			// The learner-filesystem set is always-on (user-decided 2026-09,
			// sources v1): the teacher locates and reads learner-referenced
			// files on its own terms — nothing auto-injects. Read-only by
			// construction (fs-shared.ts).
			read: readToolFor(ctx.libraryRoot, { beforeAccess: ctx.libraryBeforeAccess }),
			ls: lsToolFor(ctx.libraryRoot, { beforeAccess: ctx.libraryBeforeAccess }),
			find: findToolFor(ctx.libraryRoot, { beforeAccess: ctx.libraryBeforeAccess }),
			grep: grepToolFor(ctx.libraryRoot, { beforeAccess: ctx.libraryBeforeAccess }),
			...planTools(ctx),
			...jobTools({ chatId: ctx.chatId, jobStore: ctx.jobStore, spawn: ctx.spawn, searchAvailable: ctx.searchAvailable }),
			...(ctx.documents ? documentTools(ctx.documents) : {}),
			...gradeFor(ctx, mechanics),
		},
		withoutMechanics(enabled),
		),
	);
}
