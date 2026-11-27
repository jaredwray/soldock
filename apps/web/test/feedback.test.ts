import { describe, expect, it } from "vitest";
import {
	blockReason,
	type ClientFacts,
	type DraftAttachment,
	emptyDraft,
	type FeedbackDraft,
	pageOf,
	pickRecorderType,
	previewIssue,
	scaledSize,
	submitInput,
	withAttachment,
} from "../src/features/feedback/model.ts";
import { itemPath, parseRoute } from "../src/routes.ts";

// The feedback dialog: what goes in the public issue, and the decisions of screen capture.

const facts: ClientFacts = { appVersion: "0.0.0", page: "mail", userAgent: "Test Browser" };
const reporter = { display_name: "Ada Lovelace", address: "ada@example.com", org_role: "member" as const };

function stored(id: string): DraftAttachment {
	return {
		key: id,
		kind: "image",
		previewUrl: `blob:${id}`,
		state: "ready",
		error: null,
		stored: {
			id,
			kind: "image",
			mime_type: "image/png",
			size: 10,
			width: 1,
			height: 1,
			token: "t".repeat(43),
			url: `https://dock.example.com/dl/feedback/${id}/${"t".repeat(43)}`,
			created_at: "2026-01-01T00:00:00.000Z",
		},
	};
}

function draft(patch: Partial<FeedbackDraft> = {}): FeedbackDraft {
	return { ...emptyDraft("key-1"), title: "Blank inbox", description: "It does not load.", confirmed: true, ...patch };
}

describe("pageOf", () => {
	it("gives the kind of the page, never an id or a query string", () => {
		expect(pageOf(parseRoute("/mail/inbox/thr_01JD3V0Y9XG8Q2W4E6R8T0Y2U4"))).toBe("mail");
		expect(pageOf(parseRoute("/admin/general"))).toBe("admin/general");
		expect(pageOf(parseRoute("/settings/api-keys"))).toBe("settings/api-keys");
		const doc = itemPath({
			kind: "doc",
			space_id: "prn_01JD3V0Y9XG8Q2W4E6R8T0Y2U4",
			id: "itm_01JD3V0Y9XG8Q2W4E6R8T0Y2U4",
		});
		expect(pageOf(parseRoute(doc ?? ""))).toBe("doc");
	});
});

describe("submitInput", () => {
	it("sends only uploaded attachments, the identity choices, and the browser only when the person allows it", () => {
		const uploading: DraftAttachment = { ...stored("fba_2"), state: "uploading", stored: null };
		const input = submitInput(
			draft({ attachments: [stored("fba_1"), uploading], includeEmail: true, includeBrowser: false }),
			facts,
		);
		expect(input.attachments).toEqual([{ id: "fba_1", token: "t".repeat(43) }]);
		expect(input.include).toEqual({ name: true, email: true });
		expect(input.context).toEqual({ app_version: "0.0.0", page: "mail" });
		expect(input.idempotency_key).toBe("key-1");
	});
});

describe("withAttachment", () => {
	it("stops at the limit when one drop has many files, and clears the confirmation", () => {
		// The widget adds each file of a drop to the result of the file before, with no render between them.
		let current = draft();
		const refused: string[] = [];
		for (const id of ["fba_1", "fba_2", "fba_3", "fba_4"]) {
			const next = withAttachment(current, stored(id), 3);
			if (next) current = next;
			else refused.push(id);
		}
		expect(current.attachments.map((item) => item.key)).toEqual(["fba_1", "fba_2", "fba_3"]);
		expect(refused).toEqual(["fba_4"]);
		expect(current.confirmed).toBe(false);
	});
});

describe("blockReason", () => {
	it("waits for a title, a description, the uploads and the confirmation", () => {
		expect(blockReason(draft())).toBeNull();
		expect(blockReason(draft({ title: "  " }))).toBe("Enter a title.");
		expect(blockReason(draft({ confirmed: false }))).toMatch(/Confirm/);
		expect(blockReason(draft({ attachments: [{ ...stored("fba_1"), state: "uploading" }] }))).toMatch(/Wait/);
		expect(blockReason(draft({ attachments: [{ ...stored("fba_1"), state: "failed" }] }))).toMatch(/Remove/);
	});
});

describe("previewIssue", () => {
	it("shows the name and the address only as the person chose", () => {
		const named = previewIssue(draft(), reporter, "dock.example.com", facts).body;
		expect(named).toContain("Ada Lovelace");
		expect(named).not.toContain("ada@example.com");
		const anonymous = previewIssue(draft({ includeName: false }), reporter, "dock.example.com", facts).body;
		expect(anonymous).not.toContain("Ada Lovelace");
		expect(anonymous).toContain("dock.example.com");
	});
});

describe("screen capture", () => {
	it("picks the first recorder type that the browser supports", () => {
		expect(pickRecorderType(() => true)).toBe("video/webm;codecs=vp9");
		expect(pickRecorderType((type) => type === "video/mp4")).toBe("video/mp4");
		expect(pickRecorderType(() => false)).toBeNull();
	});

	it("makes a wide screenshot smaller with the same shape", () => {
		expect(scaledSize(3840, 2160)).toEqual({ width: 1920, height: 1080 });
		expect(scaledSize(1280, 720)).toEqual({ width: 1280, height: 720 });
	});
});
