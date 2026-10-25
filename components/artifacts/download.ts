/**
 * Artifact download helpers (release polish, 2026-10-07): the tiny
 * save-a-blob seam shared by the demo + figure cards, plus the filename
 * slug. The slug is pure (test-pinned); downloadFile touches the DOM and
 * only runs on click.
 */

/** Slugify a demo title into a filename stem — lowercase, accents folded,
 *  runs of non-alphanumerics collapsed to "-", trimmed, capped at 64
 *  chars. Empty/fully-symbolic titles fall back to "demo". */
export function slugFilename(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug || "demo";
}

/** How a save is delivered: touch devices go through the share sheet (Save
 *  to Files, AirDrop) when it accepts files, because iOS Safari and many
 *  Android browsers ignore `<a download>` on blob URLs; everything else
 *  uses the anchor. Pure so the choice can be pinned. */
export function pickDownloadRoute(coarse: boolean, canShareFiles: boolean): "share" | "anchor" {
	return coarse && canShareFiles ? "share" : "anchor";
}

/** Save text as a downloaded file. The anchor is attached to the DOM for the
 *  click (Firefox and some WebViews ignore detached ones) and the blob URL
 *  is revoked late: revoking right after the click cancels slow downloads
 *  on Safari and Android. A cancelled share sheet is not an error. */
export function downloadFile(name: string, text: string, mime: string): void {
	const file = new File([text], name, { type: mime });
	const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
	const canShare = typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
	if (pickDownloadRoute(coarse, canShare) === "share") {
		navigator.share({ files: [file], title: name }).catch((e: unknown) => {
			if (e instanceof DOMException && e.name === "AbortError") return;
			anchorDownload(file, name);
		});
		return;
	}
	anchorDownload(file, name);
}

function anchorDownload(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.hidden = true;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
