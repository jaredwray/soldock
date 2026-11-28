import type { MeetSettings } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import { changeOf, draftOf, statusText } from "../src/features/admin/meetSettingsModel.ts";

const APP = "a0000000000000000000000000000001";
const OTHER_APP = "c0000000000000000000000000000002";
const SECRET = "a-realtime-app-secret-value";

const SAVED: MeetSettings = {
	app_id: APP,
	app_secret_configured: true,
	sfu_source: "settings",
	turn_key_id: null,
	turn_key_token_configured: false,
	turn_source: null,
	ready: true,
	not_ready_reason: null,
};

// The form of Admin › Meet sends each pair as a whole, as the server requires, and catches a draft that the server
// refuses before a request.
describe("the Meet settings form", () => {
	it("sends nothing for an unchanged draft, and a new secret alone for the same ID", () => {
		expect(changeOf(draftOf(SAVED), SAVED)).toEqual({ patch: {}, problem: null });
		const draft = draftOf(SAVED);
		expect(changeOf({ ...draft, sfu: { ...draft.sfu, secret: ` ${SECRET} ` } }, SAVED)).toEqual({
			patch: { app_secret: SECRET },
			problem: null,
		});
	});

	it("sends a new ID with its secret, in lower case, and asks for the secret of a new ID", () => {
		const draft = draftOf(SAVED);
		const typed = { ...draft, sfu: { ...draft.sfu, id: OTHER_APP.toUpperCase(), secret: SECRET } };
		expect(changeOf(typed, SAVED)).toEqual({ patch: { app_id: OTHER_APP, app_secret: SECRET }, problem: null });
		expect(changeOf({ ...draft, sfu: { ...draft.sfu, id: OTHER_APP } }, SAVED).problem).toBe(
			"Paste the App Secret of the new App ID.",
		);
		expect(changeOf({ ...draft, sfu: { ...draft.sfu, id: "not-an-id", secret: SECRET } }, SAVED).problem).toMatch(
			/^App ID: /,
		);
		expect(changeOf({ ...draft, turn: { ...draft.turn, secret: SECRET } }, SAVED).problem).toBe(
			"Enter the TURN Key ID of the TURN key API token.",
		);
	});

	it("removes a pair with Remove or an empty ID", () => {
		const draft = draftOf(SAVED);
		const removal = { patch: { app_id: null, app_secret: null }, problem: null };
		expect(changeOf({ ...draft, sfu: { ...draft.sfu, remove: true } }, SAVED)).toEqual(removal);
		expect(changeOf({ ...draft, sfu: { ...draft.sfu, id: "" } }, SAVED)).toEqual(removal);
	});

	it("tells why Meet is off, and that a missing TURN key limits some networks", () => {
		expect(statusText(SAVED)).toMatch(/blocks UDP/);
		expect(statusText({ ...SAVED, ready: false, not_ready_reason: "no_app" })).toMatch(/Save the App ID/);
		expect(statusText({ ...SAVED, ready: false, not_ready_reason: "api_base" })).toMatch(/REALTIME_API_BASE/);
	});
});
