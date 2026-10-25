import { LEARNER_DUE_RING, LEARNER_STATE_STYLES, type KnowledgeConceptRef, type KnowledgeOverview, type KnowledgeTopicGroup } from "@/src/core";

/**
 * The "My knowledge" Overview tab (pure, no DOM): due today, open confusions,
 * then per topic "<checked> / <total> concepts checked" and the checked concepts
 * grouped Solid / Learning / Shaky. Everything arrives computed
 * (src/core/knowledge.ts); this only renders. A concept row is a button: the
 * caller switches to the Graph tab focused on it.
 */

export const KNOWLEDGE_EMPTY_TEXT = "Nothing checked yet: answer questions in a session and your knowledge grows here.";

/** The no-evidence state, shared by both tabs. */
export function KnowledgeEmpty() {
	return (
		<div data-testid="knowledge-empty" className="flex h-full w-full items-center justify-center px-6">
			<p className="max-w-sm text-center text-sm text-muted-foreground">{KNOWLEDGE_EMPTY_TEXT}</p>
		</div>
	);
}

const day = (iso: string) => iso.slice(0, 10);

/** A state dot; a due concept carries the ring, as on the graph. */
function StateDot({ state, due }: { state: KnowledgeConceptRef["state"]; due: boolean }) {
	return (
		<span
			aria-hidden
			data-testid="state-dot"
			data-due={due ? "true" : undefined}
			className="inline-block size-2.5 shrink-0 rounded-full"
			style={{
				backgroundColor: LEARNER_STATE_STYLES[state].color,
				...(due ? { boxShadow: `0 0 0 1.5px var(--background, #0a0a0a), 0 0 0 3px ${LEARNER_DUE_RING.color}` } : {}),
			}}
		/>
	);
}

function ConceptButton({
	concept,
	onOpen,
	detail,
}: {
	concept: KnowledgeConceptRef;
	onOpen: (id: string) => void;
	detail?: string;
}) {
	return (
		<button
			type="button"
			data-testid="overview-concept"
			data-concept-id={concept.id}
			onClick={() => onOpen(concept.id)}
			className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent pointer-coarse:min-h-11"
		>
			<span className="flex w-4 shrink-0 justify-center">
				<StateDot state={concept.state} due={concept.due} />
			</span>
			<span className="min-w-0 flex-1 break-words">{concept.name}</span>
			{detail && <span className="shrink-0 text-[11px] text-muted-foreground">{detail}</span>}
		</button>
	);
}

const GROUPS = [
	["solid", "Solid"],
	["learning", "Learning"],
	["shaky", "Shaky"],
] as const;

function TopicSection({ topic, onOpen }: { topic: KnowledgeTopicGroup; onOpen: (id: string) => void }) {
	return (
		<section data-testid="overview-topic" className="mb-7">
			<h3 className="break-words px-2 text-sm font-medium">{topic.label ?? "Untagged"}</h3>
			<p data-testid="overview-topic-count" className="mb-2 px-2 text-xs text-muted-foreground">
				{topic.checked} / {topic.total} concepts checked
			</p>
			{GROUPS.map(([key, title]) =>
				topic[key].length === 0 ? null : (
					<div key={key} data-testid={`overview-group-${key}`} className="mb-2">
						<div className="px-2 pb-0.5 pt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
							{title} · {topic[key].length}
						</div>
						{topic[key].map((c) => (
							<ConceptButton key={c.id} concept={c} onOpen={onOpen} detail={c.due ? "due" : undefined} />
						))}
					</div>
				),
			)}
		</section>
	);
}

export function KnowledgeOverviewBody({ overview, onOpenConcept }: { overview: KnowledgeOverview; onOpenConcept: (id: string) => void }) {
	if (overview.checkedCount === 0) return <KnowledgeEmpty />;
	return (
		<div data-testid="knowledge-overview" className="mx-auto w-full max-w-3xl px-3 pb-10 pt-5">
			<section data-testid="overview-due" className="mb-7">
				<h2 className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Due today</h2>
				{overview.due.length === 0 ? (
					<p className="px-2 text-xs text-muted-foreground">Nothing is due.</p>
				) : (
					overview.due.map((c) => (
						<ConceptButton key={c.id} concept={c} onOpen={onOpenConcept} detail={c.nextReviewAt ? `since ${day(c.nextReviewAt)}` : undefined} />
					))
				)}
			</section>
			<section data-testid="overview-confusions" className="mb-8">
				<h2 className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Open confusions</h2>
				{overview.confusions.length === 0 ? (
					<p className="px-2 text-xs text-muted-foreground">No open confusions.</p>
				) : (
					overview.confusions.map((m) => (
						<button
							key={`${m.conceptId}:${m.term}`}
							type="button"
							data-testid="overview-confusion"
							onClick={() => onOpenConcept(m.conceptId)}
							className="mb-1 flex w-full flex-col gap-0.5 rounded-lg px-2 py-2 text-left text-xs leading-relaxed transition-colors hover:bg-accent pointer-coarse:min-h-11"
						>
							<span className="break-words text-sm font-medium">{m.conceptName}</span>
							<span className="break-words">You thought: {m.term}</span>
							{m.instead && <span className="break-words">Instead: {m.instead}</span>}
							{m.why && <span className="break-words text-muted-foreground">Why: {m.why}</span>}
						</button>
					))
				)}
			</section>
			<h2 className="px-2 pb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">By topic</h2>
			{overview.topics.map((t) => (
				<TopicSection key={t.label ?? "\u0000untagged"} topic={t} onOpen={onOpenConcept} />
			))}
		</div>
	);
}
