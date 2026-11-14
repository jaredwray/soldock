import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon, type IconName } from "../src/lib/icons.tsx";

// The Iconoir file of each icon. The files in src/lib/iconoir are copies from iconoir 7.12.1.
const FILES: Record<IconName, string> = {
	menu: "menu",
	search: "search",
	star: "star",
	archive: "archive",
	trash: "trash",
	mailOpen: "mail-open",
	team: "group",
	mail: "mail",
	tag: "label",
	folder: "folder",
	spam: "warning-hexagon",
	restore: "undo",
	back: "arrow-left",
	reply: "reply",
	replyAll: "reply-to-message",
	forward: "arrow-email-forward",
	paperclip: "attachment",
	plus: "plus",
	close: "xmark",
	pencil: "edit-pencil",
	download: "download",
	warning: "warning-triangle",
	inbox: "mail-in",
	send: "send-diagonal",
	allMail: "drawer",
	settings: "settings",
	shield: "shield",
	refresh: "refresh",
	copy: "copy",
	signOut: "log-out",
	chevronDown: "nav-arrow-down",
	external: "globe",
	bold: "bold",
	italic: "italic",
	underline: "underline",
	strikethrough: "strikethrough",
	link: "link",
	listBulleted: "list",
	listNumbered: "numbered-list-left",
	quote: "quote",
	clearFormat: "erase",
	heading: "text-size",
	code: "code",
	rule: "minus",
	undo: "undo",
	redo: "redo",
	drive: "hard-drive",
	file: "empty-page",
	doc: "page",
	sheet: "table",
	image: "media-image",
	folderPlus: "folder-plus",
	folderMove: "drag",
	upload: "upload",
	share: "user-plus",
	more: "more-vert",
	history: "clock-rotate-right",
	clock: "clock",
	info: "info-circle",
	check: "check",
	chevronRight: "nav-arrow-right",
	eye: "eye",
	codeBlock: "code-brackets-square",
	chat: "chat-lines",
	hash: "hashtag",
	bot: "cpu",
	lock: "lock",
	sun: "sun-light",
	moon: "half-moon",
	system: "computer",
};

const sources = import.meta.glob<string>("../src/lib/iconoir/**/*.svg", {
	query: "?raw",
	import: "default",
	eager: true,
});

function source(file: string): string {
	const svg = sources[`../src/lib/iconoir/${file}.svg`];
	if (svg === undefined) throw new Error(`src/lib/iconoir/${file}.svg is missing`);
	return svg;
}

function attributes(tag: string): Record<string, string> {
	return Object.fromEntries([...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
}

/** The drawing of an SVG: the grid, the stroke width, and each path with the attributes that change its look. */
function drawing(svg: string) {
	const root = attributes(/<svg[^>]*>/.exec(svg)?.[0] ?? "");
	const inner = svg.replace(/<svg[^>]*>/, "").replace("</svg>", "");
	const tags = [...inner.matchAll(/<([a-z]+)\b[^>]*>/g)];
	return {
		viewBox: root.viewBox,
		fill: root.fill,
		elements: tags.map((tag) => tag[1]),
		paths: tags.map((tag) => {
			const path = attributes(tag[0]);
			return {
				d: path.d,
				fill: path.fill ?? "none",
				stroke: path.stroke,
				// A path of Iconoir has the stroke width of its file, or its own.
				width: path["stroke-width"] ?? root["stroke-width"] ?? "1",
				cap: path["stroke-linecap"] ?? "butt",
				join: path["stroke-linejoin"] ?? "miter",
			};
		}),
	};
}

function rendered(name: IconName, filled = false): string {
	return renderToStaticMarkup(createElement(Icon, { name, filled }));
}

describe("Icon", () => {
	it.each(Object.entries(FILES) as [IconName, string][])("draws %s as iconoir/%s.svg", (name, file) => {
		const expected = drawing(source(file));
		expect(expected.elements.every((element) => element === "path")).toBe(true);
		expect(drawing(rendered(name))).toEqual(expected);
	});

	it("draws a set star as iconoir/solid/star.svg", () => {
		expect(drawing(rendered("star", true))).toEqual(drawing(source("solid/star")));
	});

	it("has no Iconoir file without an icon", () => {
		const used = new Set([...Object.values(FILES), "solid/star"].map((file) => `../src/lib/iconoir/${file}.svg`));
		expect(Object.keys(sources).filter((path) => !used.has(path))).toEqual([]);
	});
});
