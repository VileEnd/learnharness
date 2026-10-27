"use client";

import { useEffect, useState } from "react";
import type { DrawingScene } from "@/src/core";

/** Drawings are content-addressed and immutable, so a fetched scene is cached for the page's life. */
const cache = new Map<string, Promise<DrawingScene | null>>();

function load(chatId: string, drawingId: string): Promise<DrawingScene | null> {
	const key = `${chatId}/${drawingId}`;
	let p = cache.get(key);
	if (!p) {
		p = fetch(`/api/chats/${encodeURIComponent(chatId)}/drawings/${encodeURIComponent(drawingId)}`)
			.then(async (res) => (res.ok ? ((await res.json()) as { scene: DrawingScene }).scene : null))
			.catch(() => null);
		cache.set(key, p);
		void p.then((s) => {
			if (!s) cache.delete(key); // retry next time
		});
	}
	return p;
}

/** The submitted scene of a drawing (null until loaded, or when it cannot be). No id = no fetch. */
export function useDrawingScene(chatId: string, drawingId: string | undefined): DrawingScene | null {
	const [scene, setScene] = useState<DrawingScene | null>(null);
	useEffect(() => {
		setScene(null);
		if (!drawingId) return;
		let live = true;
		void load(chatId, drawingId).then((s) => live && setScene(s));
		return () => {
			live = false;
		};
	}, [chatId, drawingId]);
	return scene;
}
