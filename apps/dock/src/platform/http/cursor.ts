// The cursor of a list with pages. It holds the sort key of the last item of a page.

/** A cursor is base64url of the UTF-8 bytes of JSON. A name in a cursor can have characters of each script. */
export function encodeCursor(values: (string | number)[]): string {
	const bytes = new TextEncoder().encode(JSON.stringify(values));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

/** The values of a cursor, or null when the text is not a cursor with these value types. */
export function decodeCursor<T extends (string | number)[]>(cursor: string, types: ("string" | "number")[]): T | null {
	try {
		const binary = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		const values: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
		if (!Array.isArray(values) || values.length !== types.length) return null;
		if (values.some((value, index) => typeof value !== types[index])) return null;
		return values as T;
	} catch {
		return null;
	}
}
