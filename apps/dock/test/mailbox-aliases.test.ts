import { ApiError, MAILBOX_ALIAS_LIMITS } from "@asterra/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type Actor, api, callTool, drainOutbox, inject, rawMessage, seedOrg } from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

async function code(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ApiError);
	return (error as ApiError).code;
}

const toolCode = (result: Awaited<ReturnType<typeof callTool>>) =>
	result.isError ? (JSON.parse(result.content[0]?.text ?? "{}") as { code?: string }).code : "ok";

/** Creates the team mailbox support@dock.test with the given members. */
async function createSupport(members: Actor[] = [ada]) {
	const { team_mailbox } = await owner.call("directory.create_team_mailbox", {
		display_name: "Support",
		address: "support@dock.test",
		member_ids: members.map((member) => member.id),
	});
	return team_mailbox;
}

async function aliasesOf(mailboxId: string): Promise<string[]> {
	const { aliases } = await owner.call("directory.list_mailbox_aliases", { mailbox_id: mailboxId });
	return aliases.map((alias) => alias.address);
}

async function subjects(actor: Actor, mailboxId?: string): Promise<string[]> {
	const { threads } = await actor.call("mail.list_threads", {
		query: "in:inbox",
		...(mailboxId ? { mailbox_id: mailboxId } : {}),
	});
	return threads.map((thread) => thread.subject);
}

describe("mailbox aliases in the directory", () => {
	// An address belongs to the organization. Only an owner or an admin gives one to a mailbox, so a member
	// or an agent cannot take an address such as ceo@ for itself, and a narrow key cannot do it either.
	it("lets only owners and admins add and remove an alias, over REST and MCP", async () => {
		const support = await createSupport();
		const { api_key } = await owner.call("account.create_api_key", { label: "Read", scopes: ["directory.read"] });
		const narrow = api(api_key.secret);
		for (const mailboxId of [ada.id, support.id]) {
			const input = { mailbox_id: mailboxId, address: "other@dock.test" };
			expect(await code(ada.call("directory.add_mailbox_alias", input))).toBe("forbidden");
			expect(await code(bot.call("directory.add_mailbox_alias", input))).toBe("forbidden");
			expect(await code(narrow("directory.add_mailbox_alias", input))).toBe("forbidden");
			expect(await aliasesOf(mailboxId)).toEqual([]);
		}

		const added = await callTool(owner.key, "directory_add_mailbox_alias", {
			mailbox_id: ada.id,
			address: "Countess@Dock.test",
		});
		expect(added.structuredContent).toMatchObject({
			mailbox_id: ada.id,
			address: "ada@dock.test",
			aliases: [{ address: "countess@dock.test", created_at: expect.any(String) }],
		});
		const team = await owner.call("directory.add_mailbox_alias", { mailbox_id: support.id, address: "help@dock.test" });
		expect(team).toMatchObject({ mailbox_id: support.id, address: "support@dock.test" });
		expect(team.aliases.map((alias) => alias.address)).toEqual(["help@dock.test"]);

		// The address is in the path of the DELETE, with its @ encoded.
		for (const actor of [ada, bot]) {
			const input = { mailbox_id: ada.id, address: "countess@dock.test" };
			expect(await code(actor.call("directory.remove_mailbox_alias", input))).toBe("forbidden");
		}
		const input = { mailbox_id: ada.id, address: "countess@dock.test" };
		expect(await code(narrow("directory.remove_mailbox_alias", input))).toBe("forbidden");
		expect((await owner.call("directory.remove_mailbox_alias", input)).aliases).toEqual([]);
		expect(await aliasesOf(support.id)).toEqual(["help@dock.test"]);
	});

	it("lets the principal itself and the members of a team mailbox read its aliases, and no one else", async () => {
		const support = await createSupport([ada]);
		await owner.call("directory.add_mailbox_alias", { mailbox_id: ada.id, address: "countess@dock.test" });
		await owner.call("directory.add_mailbox_alias", { mailbox_id: bot.id, address: "billing@dock.test" });
		await owner.call("directory.add_mailbox_alias", { mailbox_id: support.id, address: "help@dock.test" });

		const read = (actor: Actor, mailboxId: string) =>
			actor.call("directory.list_mailbox_aliases", { mailbox_id: mailboxId });
		expect((await read(ada, ada.id)).aliases.map((alias) => alias.address)).toEqual(["countess@dock.test"]);
		expect((await read(bot, bot.id)).aliases.map((alias) => alias.address)).toEqual(["billing@dock.test"]);
		expect((await read(ada, support.id)).aliases.map((alias) => alias.address)).toEqual(["help@dock.test"]);
		expect(toolCode(await callTool(bot.key, "directory_list_mailbox_aliases", { mailbox_id: bot.id }))).toBe("ok");

		expect(await code(read(bot, ada.id))).toBe("forbidden");
		expect(await code(read(bot, support.id))).toBe("forbidden");
		expect(await code(read(ada, owner.id))).toBe("forbidden");
		// A caller that is not an owner or an admin cannot tell a missing mailbox from a mailbox of a different principal.
		expect(await code(read(ada, "tmb_00000000000000000000000000"))).toBe("forbidden");
		expect(await code(read(owner, "tmb_00000000000000000000000000"))).toBe("not_found");
		expect(await code(read(owner, "prn_00000000000000000000000000"))).toBe("not_found");
	});

	// Principals, team mailboxes and aliases share one set of addresses, in each direction.
	it("keeps each address in one place only", async () => {
		const support = await createSupport();
		await owner.call("directory.add_mailbox_alias", { mailbox_id: ada.id, address: "countess@dock.test" });
		await owner.call("directory.add_mailbox_alias", { mailbox_id: support.id, address: "help@dock.test" });

		const add = (mailboxId: string, address: string) =>
			owner.call("directory.add_mailbox_alias", { mailbox_id: mailboxId, address });
		for (const address of ["owner@dock.test", "support@dock.test", "countess@dock.test", "help@dock.test"]) {
			expect(await code(add(bot.id, address))).toBe("conflict");
		}
		expect(await code(add(support.id, "countess@dock.test"))).toBe("conflict");
		// The primary address of the mailbox is not an alias.
		expect(await code(add(ada.id, "ada@dock.test"))).toBe("conflict");
		expect(await code(add(support.id, "support@dock.test"))).toBe("conflict");

		// A new principal or team mailbox cannot take an alias.
		const createPrincipal = (address: string) =>
			owner.call("directory.create_principal", { kind: "agent", display_name: "Helper", address, sponsor_id: ada.id });
		expect(await code(createPrincipal("countess@dock.test"))).toBe("conflict");
		expect(await code(createPrincipal("help@dock.test"))).toBe("conflict");
		const createTeam = (address: string) =>
			owner.call("directory.create_team_mailbox", { display_name: "Other", address, member_ids: [] });
		expect(await code(createTeam("countess@dock.test"))).toBe("conflict");
		expect(await code(createTeam("help@dock.test"))).toBe("conflict");
		for (const address of ["countess@dock.test", "help@dock.test"]) {
			expect(await owner.call("directory.check_address", { address })).toMatchObject({
				available: false,
				reason: "taken",
			});
		}
		expect(await aliasesOf(bot.id)).toEqual([]);
	});

	it("checks the address, the limit and a second call", async () => {
		const support = await createSupport();
		const add = (mailboxId: string, address: string) =>
			owner.call("directory.add_mailbox_alias", { mailbox_id: mailboxId, address });
		for (const address of ["ada+news@dock.test", "o'brien@dock.test", "ada@other.example", "not-an-address"]) {
			expect(await code(add(ada.id, address))).toBe("invalid");
		}
		expect(await code(add("tmb_00000000000000000000000000", "x@dock.test"))).toBe("not_found");
		expect(await code(add(owner.id.replace(/.$/, "0"), "x@dock.test"))).toBe("not_found");

		// A second add changes nothing. A remove of an alias that the mailbox does not have changes nothing.
		const first = await add(ada.id, "countess@dock.test");
		expect(await add(ada.id, "countess@dock.test")).toEqual(first);
		const remove = (mailboxId: string, address: string) =>
			owner.call("directory.remove_mailbox_alias", { mailbox_id: mailboxId, address });
		expect(await remove(ada.id, "nobody@dock.test")).toEqual(first);
		// The alias of a different mailbox stays.
		expect(await remove(support.id, "countess@dock.test")).toMatchObject({ aliases: [] });
		expect(await aliasesOf(ada.id)).toEqual(["countess@dock.test"]);
		expect(await code(remove(ada.id, "ada@dock.test"))).toBe("invalid");
		expect(await code(remove(support.id, "support@dock.test"))).toBe("invalid");

		for (const mailboxId of [ada.id, support.id]) {
			const existing = (await aliasesOf(mailboxId)).length;
			for (let i = existing; i < MAILBOX_ALIAS_LIMITS.aliases; i++) await add(mailboxId, `${mailboxId}-${i}@dock.test`);
			expect(await code(add(mailboxId, `${mailboxId}-extra@dock.test`))).toBe("invalid");
			expect(await aliasesOf(mailboxId)).toHaveLength(MAILBOX_ALIAS_LIMITS.aliases);
		}
	});

	it("keeps a mail domain with an alias, and frees the alias of a deleted principal", async () => {
		await owner.call("directory.add_mail_domain", { domain: "second.test" });
		await owner.call("directory.add_mail_domain", { domain: "third.test" });
		const support = await createSupport();
		await owner.call("directory.add_mailbox_alias", { mailbox_id: support.id, address: "help@second.test" });
		await owner.call("directory.add_mailbox_alias", { mailbox_id: bot.id, address: "bot@third.test" });
		expect(await code(owner.call("directory.remove_mail_domain", { domain: "second.test" }))).toBe("conflict");
		expect(await code(owner.call("directory.remove_mail_domain", { domain: "third.test" }))).toBe("conflict");
		await owner.call("directory.remove_mailbox_alias", { mailbox_id: support.id, address: "help@second.test" });
		await owner.call("directory.remove_mail_domain", { domain: "second.test" });

		await owner.call("directory.delete_principal", { principal_id: bot.id });
		expect(await code(owner.call("directory.list_mailbox_aliases", { mailbox_id: bot.id }))).toBe("not_found");
		await owner.call("directory.add_mailbox_alias", { mailbox_id: support.id, address: "bot@third.test" });
		expect(await aliasesOf(support.id)).toEqual(["bot@third.test"]);
	});
});

describe("mail to an alias", () => {
	it("delivers inbound mail to the mailbox of the alias, with a +tag, and rejects it after a remove", async () => {
		const support = await createSupport();
		await owner.call("directory.add_mailbox_alias", { mailbox_id: ada.id, address: "countess@dock.test" });
		await owner.call("directory.add_mailbox_alias", { mailbox_id: support.id, address: "help@dock.test" });
		const news = await ada.call("mail.create_label", { name: "News" });

		const send = (to: string, subject: string) => inject(rawMessage({ from: "cy@customer.example", to, subject }), to);
		expect((await send("Countess@dock.test", "Personal")).rejected).toBeNull();
		expect((await send("countess+news@dock.test", "Tagged")).rejected).toBeNull();
		expect((await send("help@dock.test", "Order 42")).rejected).toBeNull();
		expect(await subjects(ada)).toEqual(expect.arrayContaining(["Personal", "Tagged"]));
		expect(await subjects(ada)).toHaveLength(2);
		expect(await subjects(ada, support.id)).toEqual(["Order 42"]);
		const { threads } = await ada.call("mail.list_threads", { query: "in:inbox" });
		expect(threads.find((thread) => thread.subject === "Tagged")?.label_ids).toContain(news.id);

		await owner.call("directory.remove_mailbox_alias", { mailbox_id: support.id, address: "help@dock.test" });
		expect((await send("help@dock.test", "Late")).rejected).not.toBeNull();
		expect(await subjects(ada, support.id)).toEqual(["Order 42"]);
	});

	it("delivers local mail to an alias one time, also with the primary address in the same message", async () => {
		const support = await createSupport();
		await owner.call("directory.add_mailbox_alias", { mailbox_id: ada.id, address: "countess@dock.test" });
		await owner.call("directory.add_mailbox_alias", { mailbox_id: support.id, address: "help@dock.test" });
		await owner.call("mail.send", { to: ["countess@dock.test", "ada@dock.test"], subject: "Both", text: "Hi" });
		await owner.call("mail.send", { to: ["help@dock.test"], cc: ["support@dock.test"], subject: "Team", text: "Hi" });
		await drainOutbox(owner.id);
		expect(await subjects(ada)).toEqual(["Both"]);
		expect(await subjects(ada, support.id)).toEqual(["Team"]);
		const [thread] = (await ada.call("mail.list_threads", { query: "in:inbox" })).threads;
		const { messages } = await ada.call("mail.get_thread", { thread_id: thread?.id as string });
		expect(messages).toHaveLength(1);
	});
});
