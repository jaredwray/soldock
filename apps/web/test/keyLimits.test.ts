import { describe, expect, it } from "vitest";
import {
	EMPTY_LIMIT_DRAFT,
	type LimitDraft,
	limitSummary,
	limitsFromDraft,
} from "../src/features/settings/keyLimits.ts";

const OWNER = "prn_01JC0000000000000000000000";
const DRIVE = "drv_01JC0000000000000000000001";
const FOLDER = "itm_01JC0000000000000000000002";
const DOC = "itm_01JC0000000000000000000003";
const ROOM = "rm_01JC0000000000000000000004";

function draft(change: Partial<LimitDraft>): LimitDraft {
	return { ...EMPTY_LIMIT_DRAFT, ...change };
}

describe("the limits of a new key", () => {
	it("gives no limits when no product has a limit", () => {
		expect(limitsFromDraft(EMPTY_LIMIT_DRAFT, OWNER)).toEqual({ limits: null });
		// Text of a product that is off does not count.
		const off = draft({ mail: { on: false, mailboxIds: [], query: "label:x", recipientsText: "example.com" } });
		expect(limitsFromDraft(off, OWNER)).toEqual({ limits: null });
	});

	// A person pastes the link of a folder or a doc from the address bar. An id alone is an item of the key owner.
	it("reads drives, links and ids of the Drive text, and joins them with the picked entries", () => {
		const otherText = [`https://dock.test/drive/folders/${DRIVE}/${FOLDER}`, DOC, "", DRIVE].join("\n");
		const result = limitsFromDraft(draft({ drive: { on: true, picked: [OWNER, DRIVE], otherText } }), OWNER);
		expect(result).toEqual({
			limits: {
				drive: {
					items: [
						{ space_id: OWNER },
						{ space_id: DRIVE },
						{ space_id: DRIVE, item_id: FOLDER },
						{ space_id: OWNER, item_id: DOC },
					],
				},
			},
		});
	});

	it("builds the Mail and Chat limits, and leaves out the parts that are empty", () => {
		const result = limitsFromDraft(
			draft({
				mail: { on: true, mailboxIds: [], query: "  label:invoices ", recipientsText: "Example.com\nada@partner.org" },
				chat: { on: true, roomIds: [ROOM], otherText: "" },
			}),
			OWNER,
		);
		expect(result).toEqual({
			limits: {
				mail: { query: "label:invoices", recipients: ["example.com", "ada@partner.org"] },
				chat: { room_ids: [ROOM] },
			},
		});
	});

	it("names the problem of a product that is on and has no valid entry", () => {
		const error = (change: Partial<LimitDraft>) => {
			const result = limitsFromDraft(draft(change), OWNER);
			return "error" in result ? result.error : null;
		};
		expect(error({ drive: { on: true, picked: [], otherText: "" } })).toMatch(/at least one drive/);
		expect(error({ drive: { on: true, picked: [], otherText: "my folder" } })).toMatch(/my folder/);
		expect(error({ mail: { on: true, mailboxIds: [], query: " ", recipientsText: "" } })).toMatch(/Mail limit/);
		expect(error({ mail: { on: true, mailboxIds: [], query: "", recipientsText: "bad_entry!" } })).toMatch(
			/bad_entry!/,
		);
		expect(error({ chat: { on: true, roomIds: [], otherText: "general" } })).toMatch(/general/);
	});

	it("gives one summary line for each product of the limits of a key", () => {
		expect(
			limitSummary({
				drive: {
					items: [{ space_id: DRIVE }, { space_id: OWNER, item_id: FOLDER }, { space_id: OWNER, item_id: DOC }],
				},
				mail: { query: "label:invoices", recipients: ["example.com"] },
				chat: { room_ids: [ROOM] },
			}),
		).toEqual([
			{ product: "Drive", text: "1 drive, 2 folders or documents" },
			{ product: "Mail", text: "search label:invoices; sends only to example.com" },
			{ product: "Chat", text: "1 room" },
		]);
	});
});
