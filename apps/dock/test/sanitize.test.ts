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
		["an xmp element", "<xmp><img src=x onerror=alert(1)></xmp>", /onerror|<img/i],
		["an XMP element in capitals", "<XMP><img src=x onerror=alert(1)></XMP>", /onerror|<img/i],
		["a noembed element", "<noembed><img src=x onerror=alert(1)></noembed>", /onerror|<img/i],
		["a noframes element", "<noframes><a href=javascript:alert(1)>x</a></noframes>", /javascript|<a/i],
		["a plaintext element", "<plaintext><img src=x onerror=alert(1)>", /onerror|<img/i],
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
		// The browser decodes character references in an attribute before it reads the CSS.
		[
			"a CSS url( spelled with a character reference in a style attribute",
			'<p style="background: u&#114;l(https://tracker.example/e.png)">x</p>',
			/tracker/i,
		],
		[
			"a quote from a character reference that would end the style attribute",
			'<p style="color:&quot; onmouseover=&quot;alert(1)">x</p>',
			/onmouseover="/i,
		],
		// Cleaning must not delete text: the text around a deletion joins.
		[
			"a CSS url( that the removal of javascript: would join",
			'<p style="background: ujavascript:rl(https://tracker.example/j.png)">x</p>',
			/url\(/i,
		],
		[
			"a CSS @import that the removal of javascript: would join",
			'<style>@imjavascript:port "https://tracker.example/i.css";</style>',
			/@import/i,
		],
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

	// The parser keeps the content of a raw-text element as text. Unwrapped, that text would be markup.
	it("never unwraps html, head or body, so their repeated tags cannot pass through", async () => {
		const html = await clean(`${"<head>".repeat(1000)}<body bgcolor="red"><p>x</p></body>`);
		expect(html).not.toMatch(/<head|<body|<html/i);
		expect(html).toContain("<p>x</p>");
	});

	// External CSS reaches the sanitizer on every read of a thread, so its time must be linear.
	it.each([
		["unclosed url( calls", `<style>${"url(".repeat(262_144)}</style>`],
		["url( calls with one late )", `<style>${"url(".repeat(262_144)})</style>`],
		["image-set( calls", `<style>${"image-set(".repeat(100_000)}</style>`],
		["@import rules", `<style>${"@import ".repeat(130_000)}</style>`],
		["open comments", `<style>${"/*".repeat(500_000)}</style>`],
		["url( in a style attribute", `<p style="${"url(".repeat(262_144)}">x</p>`],
	])("cleans 1 MiB of %s in linear time", async (_name, html) => {
		const started = Date.now();
		const result = await sanitizeHtml(html);
		expect(Date.now() - started).toBeLessThan(3000);
		expect(result.html).not.toMatch(/url\(|image-set\(|@import/i);
	});

	// The output style attribute holds no reference for the browser to decode, so it sees the checked CSS.
	it("keeps quoted fonts in a style attribute, and leaves other references as text", async () => {
		const html = await clean(
			'<p style="font-family: &quot;Helvetica Neue&quot;, Arial; background: url&lpar;https://tracker.example/l.png)">x</p>',
		);
		expect(html).toContain("font-family: &quot;Helvetica Neue&quot;, Arial");
		expect(html).toContain("url&amp;lpar;");
	});

	it("keeps the text of an element that is not on the allowlist", async () => {
		expect(await clean("<custom-tag>visible text</custom-tag>")).toBe("visible text");
	});
});
