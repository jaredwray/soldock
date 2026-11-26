import { env } from "cloudflare:test";
import { ApiError, MAILBOX_ALIAS_LIMITS } from "@asterra/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { addMailboxAlias } from "../src/identity/mailbox-aliases.ts";
import {
	type Actor,
	api,
	callTool,
	createActor,
	drainOutbox,
	inject,
	PASSWORD,
	rawMessage,
	seedOrg,
} from "./helpers.ts";

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

	// An admin has the same control as the owner, apart from the own mailbox of the owner.
	it("lets an admin change each mailbox apart from the mailbox of the owner", async () => {
		const support = await createSupport();
		const admin = await createActor(owner, {
			kind: "human",
			display_name: "Alan Admin",
			address: "alan@dock.test",
			org_role: "admin",
			password: PASSWORD,
		});
		const addresses = (result: { aliases: { address: string }[] }) => result.aliases.map((alias) => alias.address);
		for (const [mailboxId, address] of [
			[ada.id, "countess@dock.test"],
			[bot.id, "billing@dock.test"],
			[support.id, "help@dock.test"],
			[admin.id, "al@dock.test"],
		] as const) {
			const input = { mailbox_id: mailboxId, address };
			expect(addresses(await admin.call("directory.add_mailbox_alias", input))).toEqual([address]);
			expect(addresses(await admin.call("directory.list_mailbox_aliases", { mailbox_id: mailboxId }))).toEqual([
				address,
			]);
			expect(addresses(await admin.call("directory.remove_mailbox_alias", input))).toEqual([]);
		}

		// Only the owner changes the mailbox of the owner. The admin can read its aliases.
		const chief = { mailbox_id: owner.id, address: "chief@dock.test" };
		expect(await code(admin.call("directory.add_mailbox_alias", chief))).toBe("forbidden");
		expect(toolCode(await callTool(admin.key, "directory_add_mailbox_alias", chief))).toBe("forbidden");
		expect(addresses(await owner.call("directory.add_mailbox_alias", chief))).toEqual(["chief@dock.test"]);
		expect(await code(admin.call("directory.remove_mailbox_alias", chief))).toBe("forbidden");
		expect(addresses(await admin.call("directory.list_mailbox_aliases", { mailbox_id: owner.id }))).toEqual([
			"chief@dock.test",
		]);
		expect(addresses(await owner.call("directory.remove_mailbox_alias", chief))).toEqual([]);
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
		// A service account reads the aliases of its own mailbox, and of no other mailbox.
		const { principal: service } = await owner.call("directory.create_service_account", {
			display_name: "CI",
			address: "ci@dock.test",
		});
		const { api_key } = await owner.call("account.create_api_key", { principal_id: service.id, label: "CI" });
		const ci = api(api_key.secret);
		await owner.call("directory.add_mailbox_alias", { mailbox_id: service.id, address: "builds@dock.test" });
		expect(await ci("directory.list_mailbox_aliases", { mailbox_id: service.id })).toMatchObject({
			address: "ci@dock.test",
			aliases: [{ address: "builds@dock.test" }],
		});
		expect(await code(ci("directory.list_mailbox_aliases", { mailbox_id: ada.id }))).toBe("forbidden");

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

	// The handler does these checks before the insert. The triggers of 0040 do them again for a write that
	// does not go through the handler, such as a parallel call or the previous Worker.
	it("refuses a row of team_mailbox_aliases that the triggers do not permit", async () => {
		const support = await createSupport();
		await owner.call("directory.add_mailbox_alias", { mailbox_id: ada.id, address: "countess@dock.test" });
		await owner.call("directory.add_mailbox_alias", { mailbox_id: support.id, address: "help@dock.test" });
		const insert = (address: string) =>
			env.DIRECTORY.prepare(
				"INSERT INTO team_mailbox_aliases (address, mailbox_id, created_by, created_at) VALUES (?, ?, ?, ?)",
			)
				.bind(address, support.id, owner.id, new Date().toISOString())
				.run();
		for (const [address, abort] of [
			["ada@dock.test", "address_in_use"],
			["countess@dock.test", "address_in_use"],
			["support@dock.test", "address_in_use"],
			["sales@unsaved.example", "address_mail_domain"],
			["help@dock.test", "UNIQUE constraint failed: team_mailbox_aliases.address"],
		] as const) {
			await expect(insert(address), address).rejects.toThrow(abort);
		}
		expect(await aliasesOf(support.id)).toEqual(["help@dock.test"]);
	});

	// Each of two parallel calls can pass the check before the insert. Only one insert succeeds. The other
	// insert fails on the unique key, and its call must give the same result as a later call.
	it("gives the same result to two parallel calls that add the same alias", async () => {
		const support = await createSupport();
		for (const [mailboxId, address] of [
			[ada.id, "countess@dock.test"],
			[support.id, "help@dock.test"],
		] as const) {
			const input = { mailbox_id: mailboxId, address };
			const [first, second] = await Promise.all([
				owner.call("directory.add_mailbox_alias", input),
				owner.call("directory.add_mailbox_alias", input),
			]);
			expect(second).toEqual(first);
			expect(first.aliases.map((alias) => alias.address)).toEqual([address]);
		}

		// The two calls above do not meet in each run. This database makes the race occur each time: a second
		// call adds the alias after the check of the first call and before its insert.
		const raced = (winner: string, address: string) =>
			new Proxy(env.DIRECTORY, {
				get(db, key) {
					if (key !== "prepare") return Reflect.get(db, key, db);
					return (sql: string) => {
						const statement = db.prepare(sql);
						if (!sql.startsWith("INSERT")) return statement;
						return new Proxy(statement, {
							get(target, name) {
								if (name !== "bind") return Reflect.get(target, name, target);
								return (...values: unknown[]) => {
									const bound = target.bind(...values);
									return {
										run: async () => {
											expect(await addMailboxAlias(db, winner, address, owner.id)).toBe("added");
											return await bound.run();
										},
									};
								};
							},
						});
					};
				},
			});
		for (const [mailboxId, address] of [
			[ada.id, "lady@dock.test"],
			[support.id, "desk@dock.test"],
		] as const) {
			expect(await addMailboxAlias(raced(mailboxId, address), mailboxId, address, owner.id)).toBe("exists");
			// A different mailbox that wins the race keeps the address.
			const other = `other-${address}`;
			expect(await addMailboxAlias(raced(bot.id, other), mailboxId, other, owner.id)).toBe("taken");
		}
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
