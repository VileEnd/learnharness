"use client";

import { ChevronRightIcon, ClipboardCheckIcon } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { parseProbeDoneInput, type ProbeDoneResult } from "@/src/core";

/**
 * The probe conclusion card (docs/probe-teach-split.md §2): renders the
 * prober's probe_done call. The INPUT is the learner assessment — strand by
 * strand, where his edge sits — and it belongs to the learner as much as to
 * the transcript: it streams live while the prober writes it and stays as
 * the handoff artifact. The OUTPUT is the seam's ack (ok) or the refusal
 * the prober retried on (rendered quiet and small — it is model-facing
 * bookkeeping, kept only for transcript honesty).
 *
 * The input preview is only trustworthy while the call is pending — an
 * input-available input cleared schema validation at the boundary, and a
 * mid-stream partial is guarded below. An output-error part's input was
 * REJECTED by validation and can be any shape (live crash: the model
 * stringified `assessment`); never render it.
 *
 * A completed assessment is collapsed by default behind a "N strands" header
 * (ported from upstream 10363ed2, a90bd426); refusals, malformed calls and
 * the writing fallback stay visible. The proper assessment viewer design is
 * deferred to the UI wave; this card guarantees the data is never invisible.
 */
export function ProbeDoneCard({ part }: { part: { input?: unknown; output?: unknown; state?: unknown } }) {
	const output = part.output as ProbeDoneResult | undefined;
	const state = typeof part.state === "string" ? part.state : "";

	// Parse, don't cast (the seam rule, src/core/tool-parts.ts): the model
	// authored this input — it is consumer-trustworthy only if the SAME
	// schema the tool declared says so. The parse subsumes the old state
	// reasoning and shape guards: an errored call's stringified assessment,
	// a mid-stream partial — anything that doesn't parse falls to the
	// fallback branch. Output stays a cast: OUR execute authored it.
	const input = parseProbeDoneInput(part.input);

	// The assessment is the CALL's input (owner, context diet 2026-10-09):
	// the result's echo is gone — details is {ok:true} only, and the refusal
	// branch below still reads output.error.
	const assessment = input?.assessment;
	const strands = assessment && Array.isArray(assessment.strands) ? assessment.strands : null;
	// A refused call ({ok:false}) concluded nothing (core isProbeConclusion):
	// the heading must not claim it did.
	const refused = output !== undefined && output !== null && output.ok === false;

	const heading = (
		<>
			<ClipboardCheckIcon className="size-3.5 shrink-0 text-primary" />
			<span className="min-w-0">{refused ? "Assessment not filed yet" : "Probe concluded — your assessment"}</span>
		</>
	);

	// Refusals, rejected calls and the writing fallback stay visible and plain.
	if (!strands || refused || state === "output-error") {
		return (
			<div data-testid="probe-done-card" className="my-3 rounded-xl border bg-card/60 p-3">
				<div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					{heading}
				</div>
				<p className="text-sm text-muted-foreground">
					{refused
						? `The prober retried: ${output.error}`
						: state === "output-error"
							? "The assessment was malformed — the prober retried with a corrected one."
							: "Writing the assessment…"}
				</p>
			</div>
		);
	}

	// Each text block scrolls sideways inside itself when a formula or table is
	// wider than the card (the card clips its corners, so overflow must stay in
	// the block, never in the card).
	const scrolls = "min-w-0 max-w-full overflow-x-auto";

	// A completed assessment is a handoff artifact: collapsed by default
	// (native disclosure, local to this mounted card), the full formatted
	// input one tap away.
	return (
		<details data-testid="probe-done-card" className="group my-3 overflow-hidden rounded-xl border bg-card/60">
			<summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl p-3 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent/40 group-open:rounded-b-none group-open:border-b [&::-webkit-details-marker]:hidden">
				{heading}
				<span className="ml-auto shrink-0 font-normal normal-case tracking-normal text-muted-foreground/70">
					{strands.length} strand{strands.length === 1 ? "" : "s"}
				</span>
				<ChevronRightIcon className="size-3 shrink-0 opacity-50 transition-transform group-open:rotate-90" />
			</summary>
			<div className="divide-y">
				{strands.map((s, i) => (
					<div key={i} className="px-3 py-2">
						<ToolContentResponse className={`${scrolls} text-sm font-medium`}>{s.strand}</ToolContentResponse>
						<ToolContentResponse className={`${scrolls} mt-0.5 text-sm text-muted-foreground`}>{s.assessment}</ToolContentResponse>
					</div>
				))}
				{assessment?.summary && (
					<div className="px-3 py-2">
						<ToolContentResponse className={`${scrolls} text-sm text-muted-foreground`}>{assessment.summary}</ToolContentResponse>
					</div>
				)}
			</div>
		</details>
	);
}
