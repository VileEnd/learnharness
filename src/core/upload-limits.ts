/**
 * Upload limits and the folder-pick filter, shared by the Add-documents dialog
 * (browser) and the upload routes (server). Pure and browser-safe.
 *
 * The cap is a runaway guard, not a product limit: it sits above the OCR
 * service's 200 MB PDF cap so a real textbook is never refused here first.
 */

const MIB = 1024 * 1024;

/** The most one uploaded file may weigh. */
export const MAX_FILE_BYTES = 250 * MIB;
/** Room for the multipart envelope (boundaries, headers, the decisions field). */
export const MULTIPART_ALLOWANCE_BYTES = 1 * MIB;
/** One request carries one file (the dialog's queue), so this is its body cap. */
export const MAX_REQUEST_BYTES = MAX_FILE_BYTES + MULTIPART_ALLOWANCE_BYTES;

/** File types the library takes (the dialog's accept list, by extension). */
export const IMPORTABLE_EXTENSIONS = /\.(?:md|markdown|txt|nw|pdf)$/i;

/** What a folder pick offers: the files to add and why others were left out. */
export interface FolderPick<T> {
	accepted: T[];
	hidden: number;
	unsupported: number;
}

/** Dot-files and dot-directories below the chosen root are excluded; the root
 *  itself (segment 0) stays importable even when its own name starts with a dot. */
export function isHiddenInFolder(relativePath: string): boolean {
	return relativePath.split("/").slice(1).some((part) => part.startsWith("."));
}

/** Filter a folder pick. Only the file's own name and its hidden-ness matter;
 *  the path never reaches identity, title or topics. */
export function filterFolderPick<T extends { name: string; webkitRelativePath?: string }>(files: readonly T[]): FolderPick<T> {
	const pick: FolderPick<T> = { accepted: [], hidden: 0, unsupported: 0 };
	for (const file of files) {
		if (file.webkitRelativePath && isHiddenInFolder(file.webkitRelativePath)) pick.hidden++;
		else if (!IMPORTABLE_EXTENSIONS.test(file.name)) pick.unsupported++;
		else pick.accepted.push(file);
	}
	return pick;
}

/** "3 hidden files and 2 unsupported files skipped" - or "" when nothing was. */
export function skippedNotice({ hidden, unsupported }: { hidden: number; unsupported: number }): string {
	const part = (n: number, what: string) => `${n} ${what} file${n === 1 ? "" : "s"}`;
	const parts = [hidden > 0 && part(hidden, "hidden"), unsupported > 0 && part(unsupported, "unsupported")].filter(Boolean);
	return parts.length === 0 ? "" : `${parts.join(" and ")} skipped.`;
}
