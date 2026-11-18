import { afterEach, describe, expect, it, vi } from "vitest";
import { newVersionAvailable } from "../src/lib/newVersion.ts";

afterEach(() => vi.unstubAllGlobals());

/** The head of index.html as `vite build` writes it: the entry script, then preload links and the styles. */
function builtIndex(entry: string): string {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>Soldock</title>
		<script type="module" crossorigin src="${entry}"></script>
		<link rel="modulepreload" crossorigin href="/assets/routes-C5N99zaL.js">
		<link rel="stylesheet" crossorigin href="/assets/index-q_i1prC3.css">
	</head>
	<body><div id="root" data-soldock-shell></div></body>
</html>`;
}

const CURRENT = "/assets/index-CGiUhFOt.js";

describe("a new version of the SPA", () => {
	it.each([
		[
			"the server serves a different entry script",
			async () => new Response(builtIndex("/assets/index-Dn3wV9xQ.js")),
			true,
		],
		["the server serves the same entry script", async () => new Response(builtIndex(CURRENT)), false],
		[
			"the request fails, so the reload would show an error page",
			async () => {
				throw new TypeError("Failed to fetch");
			},
			false,
		],
		[
			"the server sends an error",
			async () => new Response(builtIndex("/assets/index-Dn3wV9xQ.js"), { status: 503 }),
			false,
		],
		["the answer is not a page of Soldock", async () => new Response("<html><body>Bad gateway</body></html>"), false],
	])("when %s gives %s", async (_case, answer, expected) => {
		vi.stubGlobal("fetch", vi.fn(answer));
		expect(await newVersionAvailable(CURRENT)).toBe(expected);
	});
});
