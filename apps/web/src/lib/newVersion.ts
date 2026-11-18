// Finds a new deploy of the SPA. It has no DOM, so apps/web/test checks it.
//
// Each build names its entry script with a hash, and the entry script contains the name of each chunk.
// So a deploy that removes a chunk of the open page also changes the name of the entry script.

/** The first script tag with `type="module"` and a `src`: the entry script of the build. */
function entryScriptOf(html: string): string | null {
	for (const [tag] of html.matchAll(/<script\s[^>]*>/gi)) {
		if (!/\stype=(["'])module\1/i.test(tag)) continue;
		const src = /\ssrc=(["'])(.*?)\1/i.exec(tag)?.[2];
		if (src !== undefined) return src;
	}
	return null;
}

/**
 * True when the server serves a different build than the page. `current` is the entry script of the
 * page. A failed request, or a page that the server cannot answer, gives false.
 */
export async function newVersionAvailable(current: string): Promise<boolean> {
	try {
		const response = await fetch("/", { cache: "no-store", headers: { accept: "text/html" } });
		if (!response.ok) return false;
		const served = entryScriptOf(await response.text());
		return served !== null && served !== current;
	} catch {
		return false;
	}
}
