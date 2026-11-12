/** Parse a JSON body only from an OK response. A failed response rejects, so
 *  the caller's catch path runs instead of an error body being stored as data. */
export async function okJson<T>(res: Response): Promise<T> {
	if (!res.ok) throw new Error(`The request failed (${res.status}).`);
	return (await res.json()) as T;
}
