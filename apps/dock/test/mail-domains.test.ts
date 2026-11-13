import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import domainMigration from "../migrations/0003_mail_domains.sql?raw";
import passwordMigration from "../migrations/0004_password_sign_in.sql?raw";
import {
	api,
	callTool,
	createActor,
	drainOutbox,
	inject,
	ORIGIN,
	PASSWORD,
	rawMessage,
	request,
	SETUP_TOKEN,
	seedOrg,
	signIn,
} from "./helpers.ts";

function setup(domain: string, address: string) {
	return request("/auth/setup", {
		method: "POST",
		headers: { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify({ mail_domain: domain, address, display_name: "Owner", password: PASSWORD }),
	});
}

function domains(key: string | null, method = "GET", domain?: string) {
	return request(`/api/v1/directory/mail-domains${method === "DELETE" ? `/${domain}` : ""}`, {
		method,
		headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
		...(method === "POST" ? { body: JSON.stringify({ domain }) } : {}),
	});
}

describe("mail domain settings", () => {
	it("saves the setup domain and supports mail and sign-in at that address", async () => {
		const res = await setup(" Example.COM ", "jw@example.com");
		expect(res.status).toBe(201);
		const { api_key } = (await res.json()) as { api_key: { secret: string } };
		const call = api(api_key.secret);
		expect(await (await domains(api_key.secret)).json()).toEqual({ mail_domains: ["example.com"] });
		expect(await call("mail.get_profile")).toMatchObject({ address: "jw@example.com", mail_domains: ["example.com"] });
		const cookie = await signIn("jw@example.com");
		expect((await request("/api/v1/account", { headers: { cookie } })).status).toBe(200);
		await inject(
			rawMessage({ from: "friend@outside.example", to: "jw@example.com", subject: "Custom domain" }),
			"jw@example.com",
		);
		expect((await call("mail.list_threads")).threads).toHaveLength(1);
	});

	it("saves only the winning setup domain when two owners race", async () => {
		const results = await Promise.all([
			setup("one.example", "owner@one.example"),
			setup("two.example", "owner@two.example"),
		]);
		expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
		const winner = results.find((res) => res.status === 201);
		const body = (await winner?.json()) as { principal: { address: string }; api_key: { secret: string } };
		expect(await (await domains(body.api_key.secret)).json()).toEqual({
			mail_domains: [body.principal.address.split("@")[1]],
		});
	});

	it("lets admins add domains through REST and MCP, and protects domains with mailboxes", async () => {
		const { owner } = await seedOrg();
		const admin = await createActor(owner, {
			kind: "human",
			display_name: "Admin",
			address: "admin@dock.test",
			org_role: "admin",
			password: PASSWORD,
		});
		expect((await domains(admin.key, "POST", " Team.Example ")).status).toBe(200);
		expect((await domains(admin.key, "POST", "team.example")).status).toBe(200);
		const mcp = await callTool(admin.key, "directory_add_mail_domain", { domain: "spare.example" });
		expect(mcp.isError).not.toBe(true);
		expect((await callTool(admin.key, "directory_list_mail_domains")).structuredContent).toEqual(
			await (await domains(admin.key)).json(),
		);
		const member = await createActor(owner, {
			kind: "human",
			display_name: "Team",
			address: "member@team.example",
			password: PASSWORD,
		});
		await owner.call("mail.send", { to: [member.address], subject: "Local mail", text: "Hello" });
		await drainOutbox(owner.id);
		expect((await member.call("mail.list_threads")).threads).toMatchObject([{ subject: "Local mail" }]);
		expect((await domains(admin.key, "DELETE", "team.example")).status).toBe(409);
		expect((await domains(admin.key, "DELETE", "spare.example")).status).toBe(200);
		expect((await owner.call("mail.get_profile")).mail_domains).toContain("team.example");
		expect((await owner.call("mail.get_profile")).mail_domains).not.toContain("spare.example");
	});

	it("refuses members, agents, missing credentials, narrow keys, and cross-origin sessions", async () => {
		const { owner, ada, bot } = await seedOrg();
		for (const key of [ada.key, bot.key, null]) {
			for (const method of ["GET", "POST", "DELETE"]) {
				expect((await domains(key, method, "blocked.example")).status).toBe(key ? 403 : 401);
			}
		}
		const { api_key } = await owner.call("account.create_api_key", { label: "Read only", scopes: ["directory.read"] });
		expect((await domains(api_key.secret, "POST", "blocked.example")).status).toBe(403);
		const cookie = await signIn(owner.address);
		expect(
			(
				await request("/api/v1/directory/mail-domains", {
					method: "POST",
					headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
					body: JSON.stringify({ domain: "blocked.example" }),
				})
			).status,
		).toBe(403);
		expect(
			(
				await request("/api/v1/directory/mail-domains", {
					method: "POST",
					headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
					body: JSON.stringify({ domain: "allowed.example" }),
				})
			).status,
		).toBe(200);
	});

	it.each([
		"https://example.com",
		"user@example.com",
		"localhost",
		"*.example.com",
		"-bad.example",
		"bad..example",
		`${"a".repeat(64)}.example`,
	])("refuses the invalid domain %s", async (domain) => {
		const { owner } = await seedOrg();
		expect((await domains(owner.key, "POST", domain)).status).toBe(400);
	});

	it("carries existing mailbox domains into settings on upgrade", async () => {
		const { owner } = await seedOrg();
		await env.DIRECTORY.prepare("DROP TABLE mail_domains").run();
		// A directory from before 0003 gets 0003 and then 0004 on deploy.
		await env.DIRECTORY.batch(
			[
				...domainMigration.split("--> statement-breakpoint"),
				...passwordMigration.split("--> statement-breakpoint"),
			].map((sql) => env.DIRECTORY.prepare(sql)),
		);
		expect(await (await domains(owner.key)).json()).toEqual({ mail_domains: ["dock.test"] });
		expect((await domains(owner.key, "DELETE", "dock.test")).status).toBe(409);
	});

	it("keeps mailbox addresses on saved domains when account creation races domain removal", async () => {
		const { owner } = await seedOrg();
		expect((await domains(owner.key, "POST", "race.example")).status).toBe(200);
		const results = await Promise.all([
			domains(owner.key, "DELETE", "race.example"),
			request("/api/v1/directory/principals", {
				method: "POST",
				headers: { authorization: `Bearer ${owner.key}`, "content-type": "application/json" },
				body: JSON.stringify({
					kind: "human",
					display_name: "Race",
					address: "race@race.example",
					password: PASSWORD,
				}),
			}),
		]);
		expect(results.filter((res) => res.ok)).toHaveLength(1);
		const { principals } = await owner.call("directory.list_principals");
		const { mail_domains } = await owner.call("directory.list_mail_domains");
		for (const principal of principals) expect(mail_domains).toContain(principal.address.split("@")[1]);
	});
});
