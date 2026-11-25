import { MAIL_LIMITS } from "@asterra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor, api, callTool, codeOf, createActor, PASSWORD, seedOrg } from "./helpers.ts";

// The mail settings of a person live in their own mailbox. The web app saves the collapsed sections
// of the sidebar there, so they follow the person to each browser.

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

const DEFAULTS = {
	sidebar: { shared_mailboxes_collapsed: false, agent_mailboxes_collapsed: false },
	default_mailbox_id: null,
};

/** Creates the team mailbox support@dock.test with the given members, and returns its id. */
async function createSupport(members: { id: string; scopes?: ("mail.read" | "mail.modify" | "mail.send")[] }[]) {
	const { team_mailbox } = await owner.call("directory.create_team_mailbox", {
		display_name: "Support",
		address: "support@dock.test",
		member_ids: members.map((member) => member.id),
	});
	for (const member of members) {
		if (member.scopes) {
			await owner.call("directory.add_team_mailbox_member", {
				mailbox_id: team_mailbox.id,
				principal_id: member.id,
				scopes: member.scopes,
			});
		}
	}
	return team_mailbox.id;
}

/** A key of `actor` that holds only the given scopes. */
async function narrowKey(actor: Actor, scopes: ("mail.read" | "mail.modify")[]) {
	const { api_key } = await actor.call("account.create_api_key", { label: "Narrow", scopes });
	return api(api_key.secret);
}

/** The audit lines that the Worker wrote while `run` ran. */
async function auditLines(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
	const spy = vi.spyOn(console, "log");
	try {
		await run();
		return spy.mock.calls
			.map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null))
			.filter((line): line is Record<string, unknown> => line?.audit === true);
	} finally {
		spy.mockRestore();
	}
}

describe("mail settings", () => {
	it("starts with the defaults, saves each change, and keeps the other settings", async () => {
		expect(await owner.call("mail.get_settings")).toEqual(DEFAULTS);
		const { version } = await owner.call("mail.get_profile");

		const changed = await owner.call("mail.update_settings", { sidebar: { agent_mailboxes_collapsed: true } });
		expect(changed).toEqual({
			...DEFAULTS,
			sidebar: { shared_mailboxes_collapsed: false, agent_mailboxes_collapsed: true },
		});
		// A second change names only the other setting. The first one stays.
		await owner.call("mail.update_settings", { sidebar: { shared_mailboxes_collapsed: true } });
		expect(await owner.call("mail.get_settings")).toEqual({
			...DEFAULTS,
			sidebar: { shared_mailboxes_collapsed: true, agent_mailboxes_collapsed: true },
		});
		// A setting is not mail: the web app must not get the list again for it.
		expect((await owner.call("mail.get_profile")).version).toBe(version);
	});

	it("keeps the settings of each person apart, through REST and MCP", async () => {
		const tool = await callTool(ada.key, "mail_update_settings", { sidebar: { shared_mailboxes_collapsed: true } });
		expect(tool.structuredContent).toEqual({
			...DEFAULTS,
			sidebar: { shared_mailboxes_collapsed: true, agent_mailboxes_collapsed: false },
		});
		expect(await ada.call("mail.get_settings")).toEqual(tool.structuredContent);
		expect(await owner.call("mail.get_settings")).toEqual(DEFAULTS);
	});
});

describe("the default mailbox of a person", () => {
	it("accepts a team mailbox that the person reads, and keeps the sidebar settings", async () => {
		const support = await createSupport([{ id: ada.id }]);
		await ada.call("mail.update_settings", { sidebar: { agent_mailboxes_collapsed: true } });

		const changed = await ada.call("mail.update_settings", { default_mailbox_id: support });
		expect(changed).toEqual({
			...DEFAULTS,
			sidebar: { ...DEFAULTS.sidebar, agent_mailboxes_collapsed: true },
			default_mailbox_id: support,
		});
		// A change of a sidebar section keeps the default, and the default is for this person only.
		await ada.call("mail.update_settings", { sidebar: { shared_mailboxes_collapsed: true } });
		expect((await ada.call("mail.get_settings")).default_mailbox_id).toBe(support);
		expect(await owner.call("mail.get_settings")).toEqual(DEFAULTS);

		// The own id and null both mean the own mailbox.
		expect((await ada.call("mail.update_settings", { default_mailbox_id: ada.id })).default_mailbox_id).toBeNull();
		await ada.call("mail.update_settings", { default_mailbox_id: support });
		expect((await ada.call("mail.update_settings", { default_mailbox_id: null })).default_mailbox_id).toBeNull();
	});

	it("refuses a mailbox that the person cannot open, and leaves the setting as it was", async () => {
		const support = await createSupport([{ id: bot.id }]);
		// Not a member of the team mailbox.
		expect(await codeOf(ada.call("mail.update_settings", { default_mailbox_id: support }))).toBe("forbidden");
		// An unknown team mailbox.
		expect(
			await codeOf(ada.call("mail.update_settings", { default_mailbox_id: "tmb_00000000000000000000000000" })),
		).toBe("not_found");
		// The mailbox of an agent, also for the owner who can read it, and the mailbox of a different person.
		expect(await codeOf(owner.call("mail.update_settings", { default_mailbox_id: bot.id }))).toBe("invalid");
		expect(await codeOf(owner.call("mail.update_settings", { default_mailbox_id: ada.id }))).toBe("invalid");
		expect(await ada.call("mail.get_settings")).toEqual(DEFAULTS);
	});

	it("needs mail.read in the membership", async () => {
		const support = await createSupport([{ id: ada.id, scopes: ["mail.send"] }]);
		expect(await codeOf(ada.call("mail.update_settings", { default_mailbox_id: support }))).toBe("forbidden");
	});
});

describe("the settings of a mailbox", () => {
	it("starts with no signature, saves one, clears it, and does not change the mailbox version", async () => {
		expect(await ada.call("mail.get_mailbox_settings")).toEqual({ mailbox_id: ada.id, signature: "" });
		const { version } = await ada.call("mail.get_profile");

		// Line breaks become \n, and the spaces at the end of a line and the empty lines at the end go.
		const saved = await ada.call("mail.update_mailbox_settings", { signature: "Ada Lovelace  \r\nAnalyst\r\n\r\n" });
		expect(saved).toEqual({ mailbox_id: ada.id, signature: "Ada Lovelace\nAnalyst" });
		expect(await ada.call("mail.get_mailbox_settings", { mailbox_id: ada.id })).toEqual(saved);
		// A request must name a setting. It cannot read the settings with the scope to change them.
		expect(await codeOf(ada.call("mail.update_mailbox_settings", {}))).toBe("invalid");
		expect(await ada.call("mail.get_mailbox_settings")).toEqual(saved);
		expect((await ada.call("mail.get_profile")).version).toBe(version);
		// Each mailbox has its own signature.
		expect((await owner.call("mail.get_mailbox_settings")).signature).toBe("");

		// mail.send never adds the signature: the message has the text of the request.
		const sent = await ada.call("mail.send", { to: [owner.address], subject: "Hi", text: "Hello." });
		expect((await ada.call("mail.get_message", { message_id: sent.message_id })).body.text?.trim()).toBe("Hello.");

		expect(await ada.call("mail.update_mailbox_settings", { signature: "" })).toEqual({
			mailbox_id: ada.id,
			signature: "",
		});
	});

	it("refuses a signature that is too long or holds control characters", async () => {
		const tooLong = "x".repeat(MAIL_LIMITS.signatureChars + 1);
		expect(await codeOf(ada.call("mail.update_mailbox_settings", { signature: tooLong }))).toBe("invalid");
		expect(await codeOf(ada.call("mail.update_mailbox_settings", { signature: "Ada\u0007" }))).toBe("invalid");
		// A control that changes the direction of text could hide or move text in the mail of each member.
		expect(await codeOf(ada.call("mail.update_mailbox_settings", { signature: "Ada\u202Egro.live" }))).toBe("invalid");
		// The invisible direction marks move text too.
		expect(await codeOf(ada.call("mail.update_mailbox_settings", { signature: "Ada\u200Fgro.live" }))).toBe("invalid");
		expect(
			(await ada.call("mail.update_mailbox_settings", { signature: "x".repeat(MAIL_LIMITS.signatureChars) })).signature,
		).toHaveLength(MAIL_LIMITS.signatureChars);
	});

	it("works through MCP, and a key with only mail.read reads it and cannot change it", async () => {
		const tool = await callTool(ada.key, "mail_update_mailbox_settings", { signature: "Ada" });
		expect(tool.structuredContent).toEqual({ mailbox_id: ada.id, signature: "Ada" });
		const read = await callTool(ada.key, "mail_get_mailbox_settings");
		expect(read.structuredContent).toEqual(tool.structuredContent);

		const reader = await narrowKey(ada, ["mail.read"]);
		expect(await reader("mail.get_mailbox_settings")).toEqual({ mailbox_id: ada.id, signature: "Ada" });
		expect(await codeOf(reader("mail.update_mailbox_settings", { signature: "Eve" }))).toBe("forbidden");
		expect((await ada.call("mail.get_mailbox_settings")).signature).toBe("Ada");
	});

	it("writes an audit line that names the mailbox and never holds the signature", async () => {
		const support = await createSupport([{ id: ada.id }]);
		const lines = await auditLines(() =>
			ada.call("mail.update_mailbox_settings", { mailbox_id: support, signature: "Private line" }),
		);
		const line = lines.find((entry) => entry.op === "mail.update_mailbox_settings");
		expect(line).toMatchObject({ actor: ada.id, target: support, mailbox: support, result: "ok" });
		expect(JSON.stringify(lines)).not.toContain("Private line");
		// A request that names no setting is refused, so it writes no line of a change.
		const empty = await auditLines(() =>
			codeOf(ada.call("mail.update_mailbox_settings", { mailbox_id: support })).then((code) =>
				expect(code).toBe("invalid"),
			),
		);
		expect(empty.filter((entry) => entry.op === "mail.update_mailbox_settings" && entry.result === "ok")).toEqual([]);
	});

	it("is shared by the members of a team mailbox, and each member needs the scope in the membership", async () => {
		const grace = await createActor(owner, {
			kind: "human",
			display_name: "Grace Hopper",
			address: "grace@dock.test",
			password: PASSWORD,
		});
		const support = await createSupport([{ id: ada.id }, { id: grace.id, scopes: ["mail.read", "mail.send"] }]);

		await ada.call("mail.update_mailbox_settings", { mailbox_id: support, signature: "The Support team" });
		// Each member reads the same signature. A member without mail.modify reads it and cannot change it.
		expect(await grace.call("mail.get_mailbox_settings", { mailbox_id: support })).toEqual({
			mailbox_id: support,
			signature: "The Support team",
		});
		expect(await codeOf(grace.call("mail.update_mailbox_settings", { mailbox_id: support, signature: "Grace" }))).toBe(
			"forbidden",
		);
		// The team signature is not the signature of the own mailbox of a member.
		expect((await ada.call("mail.get_mailbox_settings")).signature).toBe("");
		// A person who is not a member cannot read it, also the owner.
		expect(await codeOf(owner.call("mail.get_mailbox_settings", { mailbox_id: support }))).toBe("forbidden");
		// A removed member loses access at once.
		await owner.call("directory.remove_team_mailbox_member", { mailbox_id: support, principal_id: grace.id });
		expect(await codeOf(grace.call("mail.get_mailbox_settings", { mailbox_id: support }))).toBe("forbidden");
	});

	it("lets an agent change only its own signature, never the signature of a team mailbox", async () => {
		const support = await createSupport([{ id: bot.id }]);
		expect(await bot.call("mail.update_mailbox_settings", { signature: "Billing Bot" })).toEqual({
			mailbox_id: bot.id,
			signature: "Billing Bot",
		});
		// The agent reads the team signature. A change there would go into the mail of each member.
		expect((await bot.call("mail.get_mailbox_settings", { mailbox_id: support })).signature).toBe("");
		expect(await codeOf(bot.call("mail.update_mailbox_settings", { mailbox_id: support, signature: "Pay now" }))).toBe(
			"forbidden",
		);
		const tool = await callTool(bot.key, "mail_update_mailbox_settings", { mailbox_id: support, signature: "Pay" });
		expect(tool.isError).toBe(true);
		expect((await bot.call("mail.get_mailbox_settings", { mailbox_id: support })).signature).toBe("");
	});

	it("lets a service account change its own signature, never the signature of a team mailbox", async () => {
		const { principal } = await owner.call("directory.create_service_account", {
			display_name: "CI Pipeline",
			address: "ci@dock.test",
			description: "Posts build results",
			sponsor_id: ada.id,
		});
		const { api_key } = await owner.call("account.create_api_key", { principal_id: principal.id, label: "ci" });
		const service = api(api_key.secret);
		expect(await service("mail.update_mailbox_settings", { signature: "CI" })).toEqual({
			mailbox_id: principal.id,
			signature: "CI",
		});
		// In a team mailbox, the rule for an agent is also the rule for a service account.
		const support = await createSupport([{ id: principal.id }, { id: ada.id }]);
		expect(await codeOf(service("mail.update_mailbox_settings", { mailbox_id: support, signature: "Pay now" }))).toBe(
			"forbidden",
		);
		expect((await ada.call("mail.get_mailbox_settings", { mailbox_id: support })).signature).toBe("");
	});

	it("lets an owner or an admin read the signature of an agent, and not change it", async () => {
		await bot.call("mail.update_mailbox_settings", { signature: "Billing Bot" });
		expect(await owner.call("mail.get_mailbox_settings", { mailbox_id: bot.id })).toEqual({
			mailbox_id: bot.id,
			signature: "Billing Bot",
		});
		expect(await codeOf(owner.call("mail.update_mailbox_settings", { mailbox_id: bot.id, signature: "Owner" }))).toBe(
			"forbidden",
		);
		// A person who is not an owner or an admin cannot read it, also the sponsor. The mailbox of a person stays private.
		expect(await codeOf(ada.call("mail.get_mailbox_settings", { mailbox_id: bot.id }))).toBe("forbidden");
		expect(await codeOf(owner.call("mail.get_mailbox_settings", { mailbox_id: ada.id }))).toBe("forbidden");
		expect(await codeOf(bot.call("mail.get_mailbox_settings", { mailbox_id: ada.id }))).toBe("forbidden");
		expect((await bot.call("mail.get_mailbox_settings")).signature).toBe("Billing Bot");
	});
});
