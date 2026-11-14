import { beforeEach, describe, expect, it } from "vitest";
import { type Actor, callTool, seedOrg } from "./helpers.ts";

// The mail settings of a person live in their own mailbox. The web app saves the collapsed sections
// of the sidebar there, so they follow the person to each browser.

let owner: Actor;
let ada: Actor;

beforeEach(async () => {
	({ owner, ada } = await seedOrg());
});

const DEFAULTS = { sidebar: { shared_mailboxes_collapsed: false, agent_mailboxes_collapsed: false } };

describe("mail settings", () => {
	it("starts with the defaults, saves each change, and keeps the other settings", async () => {
		expect(await owner.call("mail.get_settings")).toEqual(DEFAULTS);
		const { version } = await owner.call("mail.get_profile");

		const changed = await owner.call("mail.update_settings", { sidebar: { agent_mailboxes_collapsed: true } });
		expect(changed).toEqual({ sidebar: { shared_mailboxes_collapsed: false, agent_mailboxes_collapsed: true } });
		// A second change names only the other setting. The first one stays.
		await owner.call("mail.update_settings", { sidebar: { shared_mailboxes_collapsed: true } });
		expect(await owner.call("mail.get_settings")).toEqual({
			sidebar: { shared_mailboxes_collapsed: true, agent_mailboxes_collapsed: true },
		});
		// A setting is not mail: the web app must not get the list again for it.
		expect((await owner.call("mail.get_profile")).version).toBe(version);
	});

	it("keeps the settings of each person apart, through REST and MCP", async () => {
		const tool = await callTool(ada.key, "mail_update_settings", { sidebar: { shared_mailboxes_collapsed: true } });
		expect(tool.structuredContent).toEqual({
			sidebar: { shared_mailboxes_collapsed: true, agent_mailboxes_collapsed: false },
		});
		expect(await ada.call("mail.get_settings")).toEqual(tool.structuredContent);
		expect(await owner.call("mail.get_settings")).toEqual(DEFAULTS);
	});
});
