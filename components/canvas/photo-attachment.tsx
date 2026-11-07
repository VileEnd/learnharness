"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CameraIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { preparePhoto, uploadPhoto, type PreparedPhoto } from "./photo-prepare";

/**
 * "Add photo" for a canvas task on a phone (no canvas there). The photo is prepared locally, previewed with Retake,
 * and only sent when the dock's own Submit is pressed (with the typed answer, one lane): it then rides the existing
 * drawing path as a one-image drawing (photo-prepare.ts). Not stored anywhere before that: a reload drops it.
 */

export type PhotoState =
	| { status: "idle"; error?: string }
	| { status: "preparing" }
	| { status: "ready"; photo: PreparedPhoto; previewUrl: string; error?: string };

export interface PhotoAttachment {
	state: PhotoState;
	/** A photo is ready to send. */
	ready: boolean;
	/** The photo is being prepared or sent: the controls wait. */
	busy: boolean;
	pick: (file: File) => Promise<void>;
	clear: () => void;
	/** Sends the ready photo as a drawing: the drawingId, or null (the error then shows under the control). */
	send: () => Promise<string | null>;
}

export function usePhotoAttachment(chatId: string): PhotoAttachment {
	const [state, setState] = useState<PhotoState>({ status: "idle" });
	const [sending, setSending] = useState(false);
	const sendingRef = useRef(false);
	const stateRef = useRef(state);
	stateRef.current = state;

	useEffect(
		() => () => {
			const s = stateRef.current;
			if (s.status === "ready") URL.revokeObjectURL(s.previewUrl);
		},
		[],
	);

	const drop = useCallback((next: PhotoState) => {
		const s = stateRef.current;
		if (s.status === "ready") URL.revokeObjectURL(s.previewUrl);
		setState(next);
	}, []);

	const pick = useCallback(
		async (file: File) => {
			drop({ status: "preparing" });
			try {
				const photo = await preparePhoto(file);
				setState({ status: "ready", photo, previewUrl: URL.createObjectURL(photo.jpeg) });
			} catch (e) {
				setState({ status: "idle", error: e instanceof Error ? e.message : "This photo could not be prepared." });
			}
		},
		[drop],
	);

	const clear = useCallback(() => drop({ status: "idle" }), [drop]);

	const send = useCallback(async (): Promise<string | null> => {
		const s = stateRef.current;
		if (s.status !== "ready" || sendingRef.current) return null;
		sendingRef.current = true;
		setSending(true);
		try {
			return await uploadPhoto(chatId, s.photo);
		} catch (e) {
			setState({ ...s, error: e instanceof Error ? e.message : "The photo upload failed." });
			return null;
		} finally {
			sendingRef.current = false;
			setSending(false);
		}
	}, [chatId]);

	return { state, ready: state.status === "ready", busy: state.status === "preparing" || sending, pick, clear, send };
}

export function PhotoControl({ photo, disabled = false }: { photo: PhotoAttachment; disabled?: boolean }) {
	const inputRef = useRef<HTMLInputElement>(null);
	const { state } = photo;
	const choose = () => inputRef.current?.click();
	const locked = disabled || photo.busy;
	return (
		<div data-testid="photo-control" className="flex flex-col gap-1.5">
			{/* The OS chooser offers camera and library; no `capture`, so the learner picks. */}
			<input
				ref={inputRef}
				type="file"
				accept="image/*"
				data-testid="photo-input"
				className="sr-only"
				tabIndex={-1}
				onChange={(e) => {
					const file = e.target.files?.[0];
					e.target.value = ""; // choosing the same file again (Retake) must fire change
					if (file) void photo.pick(file);
				}}
			/>
			{state.status === "ready" ? (
				<div className="flex items-end gap-2">
					{/* eslint-disable-next-line @next/next/no-img-element -- a local blob URL */}
					<img data-testid="photo-preview" src={state.previewUrl} alt="Your photo" className="max-h-32 max-w-[60%] rounded-md border border-border/70 object-contain" />
					<div className="flex flex-col items-start gap-1">
						<Button type="button" variant="outline" data-testid="photo-retake" disabled={locked} onClick={choose} className="h-9 gap-1.5 rounded-[6px] px-3 text-sm">
							<CameraIcon className="size-4" /> Retake
						</Button>
						<button
							type="button"
							data-testid="photo-remove"
							disabled={locked}
							onClick={photo.clear}
							className="rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
						>
							Remove photo
						</button>
					</div>
				</div>
			) : (
				<div className="flex items-center gap-2">
					<Button type="button" variant="outline" data-testid="photo-add" disabled={locked} onClick={choose} className="h-9 gap-1.5 rounded-[6px] px-3 text-sm">
						<CameraIcon className="size-4" /> {state.status === "preparing" ? "Preparing photo…" : "Add photo"}
					</Button>
				</div>
			)}
			{state.status !== "preparing" && state.error && (
				<span role="alert" data-testid="photo-error" className="text-xs text-destructive">
					{state.error}
				</span>
			)}
		</div>
	);
}
