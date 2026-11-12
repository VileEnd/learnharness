"use client";

import { Fragment, useMemo, useRef, type MouseEvent, type ReactNode, type RefObject } from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import {
	CITATION_UNAVAILABLE,
	citationCheck,
	citationSourceText,
	collectCitations,
	messageAnchorId,
	type CitationCheck,
	type LhViewMessage,
	type TutorCitation,
} from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { sessionFindRanges } from "./session-find-dom";
import { scrollSessionTarget } from "./session-navigation";

/**
 * TUTOR QUOTES IN THE TRANSCRIPT (part 1: rendering what is stored). A learner
 * message may hold citation links (core/citations.ts); each shows as the
 * quoted passage with the learner's comment and a link back to it. The
 * selection and the composer strip that CREATE citations are part 2.
 *
 * The quote is shown only when it is checked against the transcript (an
 * assistant text of this chat really contains it): a link is only text the
 * learner can type, so a forged or stale one shows a quiet note instead. The
 * quoted text renders through the hardened markdown path (MessageResponse),
 * the comment as plain text; nothing from a link is ever markup.
 */

export interface CitationActions {
	/** Confirms a citation against the transcript. */
	check: CitationCheck;
	/** Scrolls to (and flashes) the quoted passage; false when it is not on screen. */
	reveal: (citation: TutorCitation) => boolean;
}

/** The passage a citation points at: its tutor message's text parts, and the
 *  quote's range inside them when the displayed text still holds it. */
export function findCitationPassage(
	scope: HTMLElement,
	citation: Pick<TutorCitation, "messageId" | "text">,
): { element: HTMLElement; range: Range | null } | null {
	const parts = [...scope.querySelectorAll<HTMLElement>("[data-source-message-id]")]
		.filter((element) => element.getAttribute("data-source-message-id") === citation.messageId);
	if (parts.length === 0) return null;
	const lines = citation.text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
	// The whole quote first, then its first line (a quote across paragraphs is
	// several displayed runs, which no single search string spans).
	for (const query of [lines.join(" "), lines[0] ?? ""]) {
		for (const range of query ? sessionFindRanges(scope, query) : []) {
			const element = parts.find((part) => part.contains(range.startContainer));
			if (element) return { element, range };
		}
	}
	return { element: parts[0]!, range: null };
}

let flash: { element: HTMLElement; timer: number } | null = null;

function revealCitation(context: StickToBottomContext | null, citation: TutorCitation): boolean {
	const scope = context?.scrollRef.current;
	if (!context || !scope) return false;
	const passage = findCitationPassage(scope, citation);
	if (!passage) return false;
	context.stopScroll();
	scrollSessionTarget(passage.range ?? passage.element, scope, context);
	if (flash) {
		window.clearTimeout(flash.timer);
		flash.element.classList.remove("lh-source-highlight");
	}
	const { element } = passage;
	element.classList.add("lh-source-highlight");
	flash = { element, timer: window.setTimeout(() => { element.classList.remove("lh-source-highlight"); flash = null; }, 2_000) };
	return true;
}

/** The stable actions every transcript row shares (a fresh object per
 *  streamed chunk would defeat the rows' memo, so the transcript is read
 *  through a ref at call time). */
export function useCitationActions(
	chatId: string,
	messages: readonly LhViewMessage[],
	scrollContext: RefObject<StickToBottomContext | null>,
): CitationActions {
	const transcript = useRef(messages);
	transcript.current = messages;
	return useMemo(
		() => ({
			check: citationCheck((messageId) => citationSourceText(transcript.current, messageId), chatId),
			reveal: (citation) => revealCitation(scrollContext.current, citation),
		}),
		[chatId, scrollContext],
	);
}

function CitationQuote({ citation, actions }: { citation: TutorCitation; actions: CitationActions }) {
	const verified = actions.check(citation);
	const onReveal = (event: MouseEvent) => {
		// Not on screen: the link's own hash arrival (session-navigation) runs.
		if (actions.reveal(citation)) event.preventDefault();
	};
	return (
		<figure data-testid="citation-quote" className="my-1 whitespace-normal border-l-2 border-muted-foreground/30 pl-3">
			{verified ? (
				<blockquote className="max-h-64 overflow-y-auto">
					<MessageResponse mode="static">{citation.text}</MessageResponse>
				</blockquote>
			) : (
				<p className="italic text-muted-foreground">{CITATION_UNAVAILABLE}</p>
			)}
			{citation.comment ? <p className="mt-1 whitespace-pre-wrap">{citation.comment}</p> : null}
			{verified ? (
				<a
					href={`#${encodeURIComponent(messageAnchorId(citation.messageId))}`}
					onClick={onReveal}
					className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
				>
					Show in the tutor&apos;s message
				</a>
			) : null}
		</figure>
	);
}

/** A learner message's text, its tutor citations shown as quotes. Text
 *  without a citation is returned exactly as it was. */
export function UserMessageText({ text, actions }: { text: string; actions: CitationActions }) {
	const found = collectCitations(text);
	if (found.length === 0) return <>{text}</>;
	const nodes: ReactNode[] = [];
	let cursor = 0;
	found.forEach((occurrence, i) => {
		if (occurrence.start > cursor) nodes.push(<Fragment key={`t${i}`}>{text.slice(cursor, occurrence.start)}</Fragment>);
		nodes.push(<CitationQuote key={`q${i}`} citation={occurrence.citation} actions={actions} />);
		cursor = occurrence.end;
	});
	if (cursor < text.length) nodes.push(<Fragment key="tail">{text.slice(cursor)}</Fragment>);
	return <>{nodes}</>;
}
