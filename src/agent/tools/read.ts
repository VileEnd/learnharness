import * as fs from "node:fs/promises";
import { Type } from "typebox";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { requireLibraryPath, type LibraryToolOptions } from "./fs-shared.ts";
import { detectSupportedImageMimeType, processImage } from "../image-processing/index.ts";

/**
 * The read tool — sources v0 (2026-09): a Node port of pi's read semantics
 * for the learner's local files. The flow is learner-owned: he pastes file
 * paths into the chat, the agent reads on its own terms (nothing is
 * auto-injected). Unrestricted local reads are the user-decided v0 scope —
 * this is a personal study harness, not a multi-tenant service.
 *
 * Ported behaviors (mirroring pi's dist/core/tools/read.js):
 * - text files: utf-8, offset (1-indexed) / limit slicing, and the
 *   2000-line / 50KB truncation ceiling with actionable "use offset=N"
 *   continuation notices — a huge file never silently floods the context.
 * - image files (jpg/png/gif/webp/bmp, sniffed from the bytes, not the
 *   extension): EXIF-oriented, converted and resized by the shared Pi image
 *   processing (../image-processing/) within the active model's
 *   inputLimits, then returned as native image content parts so a vision
 *   model actually SEES them (tool-execute's toToolResult maps
 *   ImageFileResult to pi's ImageContent). A failed conversion is the
 *   "[Image omitted: …]" note, never an error; a text-only model gets Pi's
 *   "does not support images" note (upstream 84f9399).
 * - unreadable/missing files throw — pi turns that into an error tool
 *   result the model sees and recovers from.
 *
 * Usage guidance ships in the description (the self-contained-tools
 * principle, user-decided 2026-09: system prompts reference only
 * always-on tools — read IS always-on, but its doctrine still lives here).
 */

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

const readInput = Type.Object({
	path: Type.String({ minLength: 1, description: "Path to the file to read, relative to the library root (e.g. index.md)" }),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
});

function formatSize(bytes: number): string {
	return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

/** Slice + truncate the text body, pi's continuation-notice style. */
function readTextSlice(text: string, offset: number | undefined, limit: number | undefined): string {
	const allLines = text.split("\n");
	const totalLines = allLines.length;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	if (startLine >= totalLines) {
		throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
	}
	// honor an explicit limit first (never beyond EOF)
	let selected = allLines.slice(startLine, limit !== undefined ? startLine + limit : totalLines);
	// then the 2000-line ceiling
	let truncatedBy: "lines" | "bytes" | null = null;
	if (selected.length > MAX_LINES) {
		selected = selected.slice(0, MAX_LINES);
		truncatedBy = "lines";
	}
	// then the 50KB ceiling
	if (Buffer.byteLength(selected.join("\n"), "utf-8") > MAX_BYTES) {
		while (selected.length > 0 && Buffer.byteLength(selected.join("\n"), "utf-8") > MAX_BYTES) {
			selected.pop();
		}
		truncatedBy = "bytes";
	}
	if (truncatedBy === null) {
		const remaining = totalLines - (startLine + selected.length);
		if (remaining > 0) {
			return `${selected.join("\n")}\n\n[${remaining} more lines in file. Use offset=${startLine + selected.length + 1} to continue.]`;
		}
		return selected.join("\n");
	}
	const endLineDisplay = startLine + selected.length;
	const reason =
		truncatedBy === "lines" ? `${MAX_LINES} line limit` : `${formatSize(MAX_BYTES)} limit`;
	return `${selected.join("\n")}\n\n[Showing lines ${startLine + 1}-${endLineDisplay} of ${totalLines} (${reason}). Use offset=${endLineDisplay + 1} to continue.]`;
}

/** What the read tool needs of the active model: whether it takes images,
 *  and its per-model resize limits (pi-ai's inputLimits.images.resize). */
export type ReadModel = Pick<Model<Api>, "input" | "inputLimits">;

export interface ReadToolOptions extends LibraryToolOptions {
	/** The active model. Absent = Pi's default limits and no image note. */
	model?: ReadModel;
}

type Execute = NonNullable<AgentTool<any>["execute"]>;

/** Every execute readToolFor builds, mapped to a rebuild for another model:
 *  the agent factories bind the active model per agent (bindReadModel)
 *  without mutating a shared tool or touching a non-read tool. */
const modelRebinders = new WeakMap<Execute, (model: ReadModel) => Execute>();

function readExecute(root: string, opts: ReadToolOptions): Execute {
	const { model } = opts;
	return serverExecute("read", readInput, async ({ path: rawPath, offset, limit }, { signal }): Promise<string | ImageFileResult> => {
		await opts.beforeAccess?.();
		const absolute = await requireLibraryPath(root, rawPath);
		let buffer: Buffer;
		try {
			buffer = await fs.readFile(absolute);
		} catch {
			throw new Error(`File not found: ${rawPath}`);
		}
		const mime = detectSupportedImageMimeType(buffer);
		if (mime) {
			// A text-only model gets Pi's note and no image. Upstream attaches
			// the image and leaves the drop to pi-ai's per-API transform; the
			// Claude Code bridge forwards tool results without that transform,
			// so the image is withheld here, at the source.
			if (model && !model.input.includes("image")) {
				return { text: `Read image file [${mime}]\n[Current model does not support images. The image will be omitted from this request.]` };
			}
			const processed = await processImage(buffer, mime, { resizeOptions: model?.inputLimits?.images?.resize });
			signal?.throwIfAborted();
			const note = processed.ok
				? [`Read image file [${processed.mimeType}]`, ...processed.hints]
				: [`Read image file [${mime}]`, processed.message];
			return {
				text: note.join("\n"),
				...(processed.ok ? { images: [{ data: processed.data, mimeType: processed.mimeType }] } : {}),
			};
		}
		return readTextSlice(buffer.toString("utf-8"), offset, limit);
	});
}

/**
 * The read tool, rooted at the library. The description is pi-verbatim apart
 * from saying paths are relative to the library; a path outside the root is
 * refused (fs-shared.ts resolveLibraryPath). `opts.model` binds the active
 * model's image limits; the agent factories bind it for registries built
 * without one (bindReadModel).
 */
export function readToolFor(root: string, opts: ReadToolOptions = {}): AgentTool<typeof readInput> {
	const execute = readExecute(root, opts);
	modelRebinders.set(execute, (model) => readExecute(root, { ...opts, model }));
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file in the library (paths are relative to the library root). Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50.0KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		parameters: readInput,
		execute,
	};
}

/** Bind the active model to every library read tool in a registry (upstream
 *  84f9399's per-agent binding, keyed by the execute readToolFor built, so
 *  the heal wrapper's prepareArguments survives). Other tools pass through. */
export function bindReadModel<T extends AgentTool<any, any>>(tools: T[], model: ReadModel): T[] {
	return tools.map((tool) => {
		const rebind = tool.execute ? modelRebinders.get(tool.execute as Execute) : undefined;
		return rebind ? { ...tool, execute: rebind(model) } : tool;
	});
}
