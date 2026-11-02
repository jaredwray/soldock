import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../src/mail/sanitize.ts";

const clean = async (html: string) => (await sanitizeHtml(html)).html;

describe("sanitizeHtml", () => {
	// Each vector runs script, loads remote content or navigates when it survives. The client adds a
	// sandbox and a CSP, but the server output must already be inert.
	it.each([
		["a script element", "<p>hi</p><script>alert(1)</script>", /<script|alert/i],
		["an event handler", '<img src="x" onerror="alert(1)">', /onerror|alert/i],
		["a javascript: link", '<a href="javascript:alert(1)">x</a>', /javascript/i],
		["an obfuscated javascript: link", '<a href=" jav&#x09;ascript:alert(1)">x</a>', /href=/i],
		["a javascript: link with a tab", '<a href="java\tscript:alert(1)">x</a>', /href=/i],
		["a data: link", '<a href="data:text/html,<script>alert(1)</script>">x</a>', /href=/i],
		["SVG with onload", '<svg onload="alert(1)"><circle/></svg>', /svg|onload/i],
		["an iframe", '<iframe src="https://evil.example"></iframe>', /iframe|evil/i],
		["an object", '<object data="evil.swf"></object>', /object|evil/i],
		["a meta refresh", '<meta http-equiv="refresh" content="0;url=https://evil.example">', /meta|evil/i],
		["a base element", '<base href="https://evil.example/">', /base|evil/i],
		[
			"a form",
			'<form action="https://evil.example"><input name="password"><button>Go</button></form>',
			/input|button|action|evil/i,
		],
		["a CSS expression", '<div style="width: expression(alert(1))">x</div>', /expression/i],
		["a CSS import", "<style>@import url(https://evil.example/x.css); p { color: red }</style>", /@import|evil/i],
		[
			"a closing tag that CSS cleaning would join",
			"<style></sty@import x;le><img src=x onerror=alert(1)></style>",
			/onerror|<img|<\/style><img/i,
		],
		[
			"a script that CSS cleaning would expose",
			"<style>p{} <javascript:/style><script>alert(2)</script></style>",
			/<script|alert/i,
		],
		[
			"a CSS escape that spells url(",
			'<div style="background: \\75 rl(https://tracker.example/p.gif)">x</div>',
			/tracker/i,
		],
		[
			"a CSS image-set",
			'<style>p { background: image-set("https://tracker.example/a.png" 1x) }</style>',
			/image-set|tracker/i,
		],
		["a style sheet behavior", "<style>p { behavior: url(x.htc) }</style>", /[^-]behavior\s*:/i],
		["a srcset", '<img srcset="https://tracker.example/a.png 1x">', /srcset|tracker/i],
		["a template", "<template><script>alert(1)</script></template>", /template|script/i],
		["a comment with a conditional", "<!--[if IE]><script>alert(1)</script><![endif]-->", /script|\[if/i],
	])("removes %s", async (_name, html, forbidden) => {
		expect(await clean(html)).not.toMatch(forbidden);
	});

	it("keeps formatting and safe links, and opens links in a new browsing context without a referrer", async () => {
		const html = await clean(
			'<div style="color: red"><b>Bold</b> <a href="https://example.org/a?b=1">link</a> <a href="mailto:a@example.org">mail</a></div><table border="1"><tr><td colspan="2">cell</td></tr></table>',
		);
		expect(html).toContain('<div style="color: red"><b>Bold</b>');
		expect(html).toContain('href="https://example.org/a?b=1" target="_blank" rel="noopener noreferrer nofollow"');
		expect(html).toContain('href="mailto:a@example.org"');
		expect(html).toContain('<td colspan="2">cell</td>');
	});

	// Remote images are tracking pixels as often as not, so they are counted and dropped.
	it("blocks and counts remote images, keeps inline data images, and drops cid: references", async () => {
		const result = await sanitizeHtml(
			'<img src="https://tracker.example/p.gif"><img alt="Logo <b>" src="//cdn.example/a.png"><table background="http://x.example/bg.png"></table><img src="data:image/png;base64,iVBORw0KGgo="><img src="cid:logo@example">',
		);
		expect(result.remoteImagesBlocked).toBe(3);
		expect(result.html).not.toMatch(/tracker|cdn\.example|x\.example|cid:/);
		// A blocked image leaves its alt text, escaped, and no broken image.
		expect(result.html).toContain("Logo &lt;b&gt;");
		expect(result.html.match(/<img/g)).toHaveLength(1);
		expect(result.html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
	});

	// A url() in CSS loads like an image, so it is a tracking pixel too.
	it("blocks and counts remote url() in style attributes and style sheets, and keeps data URLs", async () => {
		const result = await sanitizeHtml(
			'<style>td { background: url("https://t.example/a.png") }</style><p style="background-image: url(//t.example/b.png); color: red">x</p><p style="background: url(data:image/png;base64,iVBORw0KGgo=)">y</p>',
		);
		expect(result.remoteImagesBlocked).toBe(2);
		expect(result.html).not.toContain("t.example");
		expect(result.html).toContain("color: red");
		expect(result.html).toContain("url(data:image/png;base64,iVBORw0KGgo=)");
	});

	it("keeps the text of an element that is not on the allowlist", async () => {
		expect(await clean("<custom-tag>visible text</custom-tag>")).toBe("visible text");
	});
});
