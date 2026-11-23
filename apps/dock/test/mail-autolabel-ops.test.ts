import { env } from "cloudflare:workers";
import { AUTO_LABELS } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Actor,
	api,
	autoLabelOutbox,
	callTool,
	captureAutoLabelJobs,
	codeOf,
	createActor,
	drainAutoLabels,
	enableAi,
	inject,
	mcp,
	PASSWORD,
	rawMessage,
	seedOrg,
} from "./helpers.ts";

// The settings of auto labels belong to a mailbox. The members of a team mailbox share them. A person
// changes them; an agent and a service account can read them, as they read labels. Owners and admins can
// read the settings of an agent mailbox, never change them.

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
	await env.DIRECTORY.prepare(
		"UPDATE ai_settings SET enabled = 0, account_id = NULL, gateway_id = NULL, allowed_models = '[]', auto_label_enabled = 0, auto_label_model = NULL",
	).run();
});

afterEach(() => {
	vi.restoreAllMocks();
});

const ICS = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nSUMMARY:Sync\r\nEND:VEVENT\r\nEND:VCALENDAR";

describe("the auto-label settings", () => {
	it("start off, say why they cannot run, and turn on each built-in label with its user label", async () => {
		const start = await ada.call("mail.get_auto_labels");
		expect(start).toMatchObject({ mailbox_id: ada.id, enabled: false, available: false, unavailable_reason: "ai_off" });
		expect(start.labels.map((label) => [label.key, label.enabled, label.label_id])).toEqual(
			AUTO_LABELS.map((label) => [label.key, false, null]),
		);
		// A person who made "Receipt" before keeps that label.
		const receipt = await ada.call("mail.create_label", { name: "receipt" });

		const on = await ada.call("mail.update_auto_labels", { enabled: true });
		expect(on.enabled).toBe(true);
		expect(on.labels.every((label) => label.enabled && label.label_id !== null)).toBe(true);
		expect(on.labels.find((label) => label.key === "receipt")?.label_id).toBe(receipt.id);
		const names = (await ada.call("mail.list_labels")).labels.filter((l) => l.type === "user").map((l) => l.name);
		expect(names).toEqual(expect.arrayContaining(["Needs reply", "Meeting", "Marketing", "Cold pitch", "receipt"]));

		await enableAi(owner, { features: { mail_auto_label: { enabled: false, model: null } } });
		expect(await ada.call("mail.get_auto_labels")).toMatchObject({
			available: false,
			unavailable_reason: "feature_off",
		});
		await enableAi(owner);
		const ready = await ada.call("mail.get_auto_labels");
		expect(ready).toMatchObject({ available: true, unavailable_reason: null });
		// MCP gives the same settings as REST.
		expect((await callTool(ada.key, "mail_get_auto_labels")).structuredContent).toEqual(ready);
	});

	it("change one label at a time, and refuse what cannot work", async () => {
		await ada.call("mail.update_auto_labels", { enabled: true });
		const changed = await ada.call("mail.update_auto_labels", {
			labels: [
				{ key: "marketing", skip_inbox: true },
				{ key: "travel", enabled: false },
			],
		});
		expect(changed.labels.find((label) => label.key === "marketing")).toMatchObject({
			enabled: true,
			skip_inbox: true,
		});
		expect(changed.labels.find((label) => label.key === "travel")).toMatchObject({ enabled: false });
		expect(
			await codeOf(
				ada.call("mail.update_auto_labels", { labels: [{ key: "newsletter", description: "Any newsletter mail" }] }),
			),
		).toBe("invalid");
		expect(
			await codeOf(
				ada.call("mail.update_auto_labels", { labels: [{ key: "alb_01HZZZZZZZZZZZZZZZZZZZZZZZ", enabled: false }] }),
			),
		).toBe("not_found");
		// A refused change leaves the rest as it was.
		expect((await ada.call("mail.get_auto_labels")).labels.find((label) => label.key === "travel")?.enabled).toBe(
			false,
		);
	});

	it("make custom auto labels with a cap, refuse a built-in name, and keep the user label after a delete", async () => {
		const created = await ada.call("mail.create_auto_label", {
			name: "Investors",
			description: "Monthly updates from the companies that we invested in",
			skip_inbox: true,
		});
		const investors = created.labels.find((label) => label.kind === "custom");
		expect(investors).toMatchObject({
			name: "Investors",
			enabled: true,
			skip_inbox: true,
			label_id: expect.any(String),
		});
		expect(
			await codeOf(
				ada.call("mail.create_auto_label", { name: "Newsletter", description: "Anything that I read weekly" }),
			),
		).toBe("conflict");
		expect(
			await codeOf(
				ada.call("mail.create_auto_label", { name: "investors", description: "Updates from investors again" }),
			),
		).toBe("conflict");
		for (let i = 2; i <= 10; i++) {
			await ada.call("mail.create_auto_label", { name: `Custom ${i}`, description: "A label for one kind of mail" });
		}
		expect(
			await codeOf(ada.call("mail.create_auto_label", { name: "Eleven", description: "One label too many here" })),
		).toBe("invalid");
		const described = await ada.call("mail.update_auto_labels", {
			labels: [{ key: investors?.key as string, description: "Board decks and updates" }],
		});
		expect(described.labels.find((label) => label.key === investors?.key)?.description).toBe("Board decks and updates");
		await ada.call("mail.delete_auto_label", { auto_label_id: investors?.key as string });
		const after = await ada.call("mail.get_auto_labels");
		expect(after.labels.some((label) => label.key === investors?.key)).toBe(false);
		expect((await ada.call("mail.list_labels")).labels.some((label) => label.id === investors?.label_id)).toBe(true);
		expect(await codeOf(ada.call("mail.delete_auto_label", { auto_label_id: investors?.key as string }))).toBe(
			"not_found",
		);
	});
});

describe("who can use the auto-label settings", () => {
	it("lets the members of a team mailbox share them, and refuses a person who is not a member", async () => {
		const grace = await createActor(owner, {
			kind: "human",
			display_name: "Grace Hopper",
			address: "grace@dock.test",
			password: PASSWORD,
		});
		const { team_mailbox: support } = await owner.call("directory.create_team_mailbox", {
			display_name: "Support",
			address: "support@dock.test",
			member_ids: [ada.id, grace.id],
		});
		await ada.call("mail.update_auto_labels", { mailbox_id: support.id, enabled: true });
		expect((await grace.call("mail.get_auto_labels", { mailbox_id: support.id })).enabled).toBe(true);
		expect((await grace.call("mail.get_auto_labels")).enabled).toBe(false);
		expect(await codeOf(owner.call("mail.update_auto_labels", { mailbox_id: support.id, enabled: false }))).toBe(
			"forbidden",
		);
	});

	it("lets an agent read its own settings, never change them, and hides the change tools", async () => {
		expect((await bot.call("mail.get_auto_labels")).mailbox_id).toBe(bot.id);
		for (const call of [
			bot.call("mail.update_auto_labels", { enabled: true }),
			bot.call("mail.create_auto_label", { name: "Bills", description: "Bills from our vendors" }),
			bot.call("mail.run_auto_labels", { dry_run: true }),
		]) {
			expect(await codeOf(call)).toBe("forbidden");
		}
		const tools = (
			((await mcp(bot.key, "tools/list")).body?.result ?? { tools: [] }) as { tools: { name: string }[] }
		).tools.map((tool) => tool.name);
		expect(tools.filter((name) => name.includes("auto_label"))).toEqual(["mail_get_auto_labels"]);
	});

	it("lets an owner read the settings of an agent mailbox, never change them", async () => {
		expect((await owner.call("mail.get_auto_labels", { mailbox_id: bot.id })).mailbox_id).toBe(bot.id);
		expect(await codeOf(owner.call("mail.update_auto_labels", { mailbox_id: bot.id, enabled: true }))).toBe(
			"forbidden",
		);
	});

	it("follows the scopes of a key and the mailboxes of a limited service account", async () => {
		const { api_key } = await owner.call("account.create_api_key", {
			principal_id: ada.id,
			label: "read only",
			scopes: ["mail.read"],
		});
		expect(await codeOf(api(api_key.secret)("mail.update_auto_labels", { enabled: true }))).toBe("forbidden");

		const { principal: service } = await owner.call("directory.create_service_account", {
			display_name: "CI Pipeline",
			address: "ci@dock.test",
			sponsor_id: ada.id,
			scopes: ["mail.read"],
		});
		const { team_mailbox: billing } = await owner.call("directory.create_team_mailbox", {
			display_name: "Billing",
			address: "billing@dock.test",
			member_ids: [service.id],
		});
		await owner.call("directory.set_service_account_access", {
			principal_id: service.id,
			resources: { mailbox_ids: [], drive_ids: [], room_ids: [] },
		});
		const { api_key: token } = await owner.call("account.create_api_key", { principal_id: service.id, label: "ci" });
		expect(await codeOf(api(token.secret)("mail.get_auto_labels", { mailbox_id: billing.id }))).toBe("forbidden");
	});
});

describe("a run of auto labels on recent inbox mail", () => {
	it("counts with a dry run, labels by rules now, queues the rest, and never moves mail", async () => {
		await inject(
			rawMessage({
				from: "Grace <grace@partner.example>",
				to: "ada@dock.test",
				subject: "Sync",
				attachment: { filename: "sync.ics", mimeType: "text/calendar", content: ICS },
			}),
			"ada@dock.test",
		);
		await inject(
			rawMessage({ from: "Grace <grace@partner.example>", to: "ada@dock.test", subject: "Question" }),
			"ada@dock.test",
		);

		expect(await codeOf(ada.call("mail.run_auto_labels", {}))).toBe("conflict");
		await enableAi(owner);
		expect(await codeOf(ada.call("mail.run_auto_labels", {}))).toBe("conflict");
		await ada.call("mail.update_auto_labels", { enabled: true, labels: [{ key: "meeting", skip_inbox: true }] });
		const jobs = await captureAutoLabelJobs(ada.id);

		const dry = await ada.call("mail.run_auto_labels", { dry_run: true });
		expect(dry).toEqual({ messages: 2, labeled_by_rules: 0, queued: 0, dry_run: true });
		expect(await autoLabelOutbox(ada.id)).toEqual([]);

		const run = await ada.call("mail.run_auto_labels", {});
		expect(run).toEqual({ messages: 2, labeled_by_rules: 1, queued: 1, dry_run: false });
		await drainAutoLabels(ada.id);
		expect(jobs).toHaveLength(1);
		const { threads } = await ada.call("mail.list_threads", { query: "subject:Sync" });
		// The run never moves mail out of the inbox, though Meeting skips it for new mail.
		expect(threads[0]?.label_ids).toContain("INBOX");
		expect(threads[0]?.auto_label_ids).toHaveLength(1);

		expect(await ada.call("mail.run_auto_labels", {})).toEqual({
			messages: 0,
			labeled_by_rules: 0,
			queued: 0,
			dry_run: false,
		});
	});
});
