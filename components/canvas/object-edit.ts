/** Pure edit helpers for the canvas's typed objects (table cells, object patches). */
import type { DrawingObject, DrawingScene, TableObject, TypedObject } from "@/src/core";

export const MIN_TABLE = 1;
export const MAX_TABLE_ROWS = 50;
export const MAX_TABLE_COLS = 12;

export function tableSetCell(cells: string[][], r: number, c: number, value: string): string[][] {
	return cells.map((row, ri) => (ri === r ? row.map((v, ci) => (ci === c ? value : v)) : row));
}
export function tableAddRow(cells: string[][], at = cells.length): string[][] {
	if (cells.length >= MAX_TABLE_ROWS) return cells;
	const width = cells[0]?.length ?? 1;
	const next = cells.map((r) => [...r]);
	next.splice(Math.max(0, Math.min(at, next.length)), 0, Array.from({ length: width }, () => ""));
	return next;
}
export function tableRemoveRow(cells: string[][], at: number): string[][] {
	if (cells.length <= MIN_TABLE || at < 0 || at >= cells.length) return cells;
	return cells.filter((_, i) => i !== at);
}
export function tableAddCol(cells: string[][], at = cells[0]?.length ?? 0): string[][] {
	if ((cells[0]?.length ?? 0) >= MAX_TABLE_COLS) return cells;
	return cells.map((row) => {
		const next = [...row];
		next.splice(Math.max(0, Math.min(at, next.length)), 0, "");
		return next;
	});
}
export function tableRemoveCol(cells: string[][], at: number): string[][] {
	if ((cells[0]?.length ?? 0) <= MIN_TABLE || at < 0 || at >= (cells[0]?.length ?? 0)) return cells;
	return cells.map((row) => row.filter((_, i) => i !== at));
}
/** Tab / Shift+Tab navigation in reading order; null = past either end. */
export function tableNextCell(cells: string[][], r: number, c: number, back: boolean): { r: number; c: number } | null {
	const w = cells[0]?.length ?? 0;
	const i = r * w + c + (back ? -1 : 1);
	if (i < 0 || i >= cells.length * w) return null;
	return { r: Math.floor(i / w), c: i % w };
}

/** Replace one object by id (z and id preserved by the patch's own fields). */
export function patchObject(scene: DrawingScene, id: string, patch: Partial<TypedObject>): DrawingScene {
	return { ...scene, objects: scene.objects.map((o) => (o.id === id ? ({ ...o, ...patch } as DrawingObject) : o)) };
}
export function removeObject(scene: DrawingScene, id: string): DrawingScene {
	return { ...scene, objects: scene.objects.filter((o) => o.id !== id) };
}
export function isTable(o: DrawingObject): o is TableObject {
	return o.type === "table";
}
