"use client";

import { useEffect } from "react";

/** The root layout itself threw. This replaces it, so it owns <html>/<body>
 *  and cannot lean on the app's stylesheet, fonts or the learner's theme
 *  (the layout that reads it is what failed). It follows the device instead:
 *  `color-scheme: light dark` with the CSS system colours, so it is readable
 *  on either, with no colour of its own. */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
	useEffect(() => {
		console.error(error);
	}, [error]);
	return (
		<html lang="en" style={{ colorScheme: "light dark" }}>
			<body style={{ margin: 0, minHeight: "100dvh", background: "Canvas", color: "CanvasText", fontFamily: "ui-monospace, monospace" }}>
				<div role="alert" style={{ maxWidth: 420, margin: "0 auto", padding: 24, display: "flex", flexDirection: "column", gap: 12, fontSize: 14 }}>
					<h2 style={{ margin: 0, fontWeight: 500 }}>Something went wrong.</h2>
					<p style={{ margin: 0, opacity: 0.7 }}>The app could not be displayed. Your data is safe.</p>
					<button
						type="button"
						onClick={() => retry()}
						style={{ alignSelf: "flex-start", padding: "6px 12px", background: "transparent", color: "inherit", border: "1px solid GrayText", borderRadius: 6, font: "inherit", cursor: "pointer" }}
					>
						Try again
					</button>
				</div>
			</body>
		</html>
	);
}
