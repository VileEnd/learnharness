"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

/** Calls `render` as a component body, so a throw in the part's own logic
 *  lands in the boundary above (a boundary never catches its own render). */
function Run({ render }: { render: () => ReactNode }) {
	return <>{render()}</>;
}

interface Props {
	render: () => ReactNode;
	/** Clears a caught failure when it changes (a streaming part that settles
	 *  into a valid shape renders again). */
	resetKey?: string;
}

/** One transcript part or artifact. A persisted part with an unexpected
 *  shape must cost only itself: a compact inline fallback, the rest of the
 *  chat renders. */
export class PartBoundary extends Component<Props, { failed: boolean; resetKey?: string | undefined }> {
	state: { failed: boolean; resetKey?: string | undefined } = { failed: false, resetKey: this.props.resetKey };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	static getDerivedStateFromProps(props: Props, state: { failed: boolean; resetKey?: string | undefined }) {
		return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("[chat] a transcript part could not be rendered:", error, info.componentStack);
	}

	render() {
		if (this.state.failed) {
			return (
				<p data-testid="part-error" role="note" className="my-1 font-ui text-xs text-muted-foreground">
					This part could not be displayed.
				</p>
			);
		}
		return <Run render={this.props.render} />;
	}
}
