import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { runScheduled } from "../src/scheduled.ts";
import { type Actor, api, createActor, PASSWORD, seedOrg } from "./helpers.ts";

// The notice before a token of a service account ends: the hourly job mails each owner and admin one
// time, seven days before the end.

const DAY = 24 * 60 * 60 * 1000;

/** The owner, an admin, a member (Ada, the sponsor), an agent, and a service account. */
async function seed() {
	const { owner, ada, bot } = await seedOrg();
	const admin = await createActor(owner, {
		kind: "human",
		display_name: "Alan Admin",
		address: "alan@dock.test",
		org_role: "admin",
		password: PASSWORD,
	});
	const { principal: service } = await admin.call("directory.create_service_account", {
		display_name: "CI Pipeline",
		address: "ci@dock.test",
		sponsor_id: ada.id,
		scopes: ["account.read", "mail.read"],
	});
	return { owner, admin, ada, bot, service };
}

/** A token of a service account with a lifetime, made by `by`. Returns its id and its end in milliseconds. */
async function token(by: Actor, principalId: string, days: number, label = "deploy") {
	const { api_key } = await by.call("account.create_api_key", {
		principal_id: principalId,
		label,
		expires_in_days: days,
	});
	return { id: api_key.id, end: Date.parse(api_key.expires_at ?? "") };
}

/** The subjects of the threads in the inbox of an actor that name the token label. */
async function notices(actor: Actor, label = "deploy"): Promise<string[]> {
	const { threads } = await actor.call("mail.list_threads", {});
	return threads.map((thread) => thread.subject).filter((subject) => subject.includes(`"${label}"`));
}

describe("the notice before a token ends", () => {
	it("mails each owner and admin one time, and records it in the log of the account", async () => {
		const { owner, admin, ada, service } = await seed();
		const due = await token(admin, service.id, 30);
		// Six days before the end: the token is due.
		await runScheduled(env, due.end - 6 * DAY);
		expect(await notices(owner)).toHaveLength(1);
		expect(await notices(admin)).toHaveLength(1);
		expect((await notices(owner))[0]).toContain("CI Pipeline");
		// The sponsor is a member, so it gets no notice. The account gets none either.
		expect(await notices(ada)).toEqual([]);
		const tokenOwner = await admin.call("account.create_api_key", { principal_id: service.id, label: "reader" });
		const own = await api(tokenOwner.api_key.secret)("mail.list_threads", {});
		expect(own.threads.filter((thread) => thread.subject.includes('"deploy"'))).toEqual([]);

		// A second run sends nothing more.
		await runScheduled(env, due.end - 5 * DAY);
		expect(await notices(owner)).toHaveLength(1);
		// A run that stops between the mail and the mark sends the same bytes again. The mailbox keeps one copy.
		await env.DIRECTORY.prepare("UPDATE api_keys SET expiry_notice_at = NULL WHERE id = ?").bind(due.id).run();
		await runScheduled(env, due.end - 5 * DAY);
		expect(await notices(owner)).toHaveLength(1);
		expect(await notices(admin)).toHaveLength(1);

		const entries = await vi.waitFor(async () => {
			const page = await admin.call("directory.list_service_account_activity", {
				principal_id: service.id,
				key_id: due.id,
			});
			const found = page.entries.filter((entry) => entry.operation === "account.token_expiry_notice");
			expect(found.length).toBeGreaterThanOrEqual(1);
			return found;
		});
		expect(entries[0]).toMatchObject({ surface: "system", result: "ok", actor_id: service.id });
	});

	it("sends nothing for a token that is not due, not live, short, or not of a live service account", async () => {
		const { owner, admin, ada, bot, service } = await seed();
		// Eight days before its end, a token is not due yet.
		const early = await token(admin, service.id, 30, "early");
		await runScheduled(env, early.end - 8 * DAY);
		expect(await notices(owner, "early")).toEqual([]);
		// A token that lived only 3 days gets no notice: its creator knew its end.
		const short = await token(admin, service.id, 3, "short");
		await runScheduled(env, short.end - DAY);
		expect(await notices(owner, "short")).toEqual([]);
		// A revoked token, and the keys of a person and of an agent, get none six days before their end.
		const revoked = await token(admin, service.id, 30, "revoked");
		await admin.call("account.revoke_api_key", { key_id: revoked.id });
		await ada.call("account.create_api_key", { label: "person", scopes: ["account.read"], expires_in_days: 30 });
		await ada.call("account.create_api_key", {
			principal_id: bot.id,
			label: "agent",
			scopes: ["account.read"],
			expires_in_days: 30,
		});
		await runScheduled(env, revoked.end - 6 * DAY);
		for (const label of ["revoked", "person", "agent"]) expect(await notices(owner, label), label).toEqual([]);
		// A token of an archived account gets none. An expired token gets none.
		const archived = await admin.call("directory.create_service_account", {
			display_name: "Old Job",
			address: "old@dock.test",
			scopes: ["account.read"],
		});
		const old = await token(admin, archived.principal.id, 30, "old");
		await admin.call("directory.archive_principal", { principal_id: archived.principal.id });
		await runScheduled(env, old.end - 6 * DAY);
		expect(await notices(owner, "old")).toEqual([]);
		const late = await token(admin, service.id, 60, "late");
		await runScheduled(env, late.end + DAY);
		expect(await notices(owner, "late")).toEqual([]);
	});
});
