import { env } from "cloudflare:workers";
import { buildFeedbackIssue } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScheduled } from "../src/scheduled.ts";
import {
	type Actor,
	api,
	callTool,
	codeOf,
	createActor,
	mcp,
	ORIGIN,
	PASSWORD,
	request,
	SEALED,
	seedOrg,
} from "./helpers.ts";

// Feedback: a person sends a bug report or an idea, and the Worker creates a public GitHub issue. The feature is
// off by default, only owners and admins change it, and only a person can send a report. The attachments are
// public at an address with a secret token, and they are never active content.

const TOKEN = `ghp_${"a".repeat(36)}`;
const ISSUES_URL = "https://api.github.com/repos/jaredwray/soldock/issues";

let owner: Actor;
let ada: Actor;
let bot: Actor;
let admin: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
	admin = await createActor(owner, {
		kind: "human",
		display_name: "Alan Admin",
		address: "alan@dock.test",
		org_role: "admin",
		password: PASSWORD,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** The requests that reach GitHub. Each one gets `answer`, or a created issue. */
function fakeGitHub(answer?: () => Response | Promise<Response>) {
	const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
	const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const req = new Request(input, init);
		calls.push({ url: req.url, headers: req.headers, body: (await req.json()) as Record<string, unknown> });
		if (answer) return await answer();
		const number = 100 + calls.length;
		return Response.json(
			{ number, html_url: `https://github.com/jaredwray/soldock/issues/${number}` },
			{ status: 201 },
		);
	});
	return { calls, spy };
}

async function turnOn(by: Actor = owner) {
	return await by.call("feedback.update_settings", { enabled: true, github_token: TOKEN });
}

/** The bytes of a PNG image of 640 × 480 pixels: the signature and the IHDR chunk are enough for the type. */
function png(): string {
	const bytes = new Uint8Array(33);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, 640);
	view.setUint32(20, 480);
	bytes.set([8, 6, 0, 0, 0], 24);
	return btoa(String.fromCharCode(...bytes));
}

/** The bytes of the start of a WebM video: an EBML header with the DocType `webm`. */
function webm(): string {
	const bytes = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ..."webm"].map((value) =>
		typeof value === "string" ? value.charCodeAt(0) : value,
	);
	return btoa(String.fromCharCode(...bytes, ...new Array(32).fill(0)));
}

const text = (value: string) => btoa(value);

const report = {
	kind: "bug" as const,
	title: "The inbox does not load",
	description: "I open Mail and see a blank page. cc @octocat",
	include: { name: true, email: false },
	context: { app_version: "0.0.0", page: "mail", user_agent: "Test Browser" },
};

/** "ok" for a call that works, else the code of its error. For calls that run at the same time. */
const outcome = (call: Promise<unknown>) =>
	call.then(
		() => "ok",
		(caught: unknown) => (caught as { code?: string }).code ?? String(caught),
	);

const countOf = (list: string[], value: string) => list.filter((item) => item === value).length;

const reportCount = async () =>
	(await env.DIRECTORY.prepare("SELECT COUNT(*) AS n FROM feedback_reports").first<number>("n")) ?? 0;

const reportRow = async (id: string) =>
	await env.DIRECTORY.prepare("SELECT status, issue_number FROM feedback_reports WHERE id = ?")
		.bind(id)
		.first<{ status: string; issue_number: number | null }>();

describe("the feedback settings", () => {
	it("start off, so the operations refuse and nothing reaches GitHub", async () => {
		const github = fakeGitHub();
		expect(await owner.call("feedback.get_settings")).toEqual({
			enabled: false,
			repo_owner: "jaredwray",
			repo_name: "soldock",
			token_configured: false,
			ready: false,
			not_ready_reason: "off",
		});
		expect(await ada.call("feedback.get_status")).toMatchObject({
			enabled: false,
			can_submit: false,
			repository: null,
		});
		expect(await codeOf(ada.call("feedback.upload_attachment", { content_base64: png() }))).toBe("forbidden");
		expect(await codeOf(ada.call("feedback.submit", report))).toBe("forbidden");
		expect(github.calls).toEqual([]);
	});

	it("need a token before people can send feedback", async () => {
		const on = await owner.call("feedback.update_settings", { enabled: true });
		expect(on).toMatchObject({ enabled: true, ready: false, not_ready_reason: "no_token" });
		expect(await ada.call("feedback.get_status")).toMatchObject({ enabled: false, can_submit: false });
		expect(await codeOf(ada.call("feedback.submit", report))).toBe("unavailable");
	});

	it("let owners and admins change them, seal the token and never return it", async () => {
		const saved = await turnOn(admin);
		expect(saved).toEqual({
			enabled: true,
			repo_owner: "jaredwray",
			repo_name: "soldock",
			token_configured: true,
			ready: true,
			not_ready_reason: null,
		});
		expect(JSON.stringify(await owner.call("feedback.get_settings"))).not.toContain(TOKEN);
		const stored = await env.DIRECTORY.prepare("SELECT github_token FROM feedback_settings WHERE id = 1").first<string>(
			"github_token",
		);
		expect(stored).toMatch(SEALED);
		// MCP gives the same settings as REST.
		expect((await callTool(owner.key, "feedback_get_settings")).structuredContent).toEqual(saved);
		expect((await owner.call("feedback.update_settings", { github_token: null })).token_configured).toBe(false);
	});

	it("refuse members, agents, service accounts and a key of an admin without the scope", async () => {
		const { principal: service } = await owner.call("directory.create_service_account", {
			display_name: "CI Pipeline",
			address: "ci@dock.test",
			sponsor_id: ada.id,
		});
		const { api_key: serviceKey } = await owner.call("account.create_api_key", {
			principal_id: service.id,
			label: "ci",
		});
		for (const key of [ada.key, bot.key, serviceKey.secret]) {
			expect(await codeOf(api(key)("feedback.get_settings", {}))).toBe("forbidden");
			expect(await codeOf(api(key)("feedback.update_settings", { enabled: true }))).toBe("forbidden");
		}
		const { api_key: reader } = await admin.call("account.create_api_key", {
			principal_id: admin.id,
			label: "read only",
			scopes: ["directory.read"],
		});
		expect((await api(reader.secret)("feedback.get_settings", {})).enabled).toBe(false);
		expect(await codeOf(api(reader.secret)("feedback.update_settings", { enabled: true }))).toBe("forbidden");
		expect((await owner.call("feedback.get_settings")).enabled).toBe(false);
	});

	it("refuse a repository that would change the path of the request", async () => {
		for (const name of ["a/b", "..", "%2f", "a b"]) {
			expect(await codeOf(owner.call("feedback.update_settings", { repo_name: name }))).toBe("invalid");
		}
		expect(await codeOf(owner.call("feedback.update_settings", { repo_owner: "-bad" }))).toBe("invalid");
	});
});

describe("a report", () => {
	it("becomes a GitHub issue with the name of the person, and without the address or the id", async () => {
		await turnOn();
		const github = fakeGitHub();
		expect(await ada.call("feedback.get_status")).toMatchObject({
			enabled: true,
			can_submit: true,
			repository: "jaredwray/soldock",
		});
		const image = await ada.call("feedback.upload_attachment", { content_base64: png() });
		expect(image).toMatchObject({ kind: "image", mime_type: "image/png", width: 640, height: 480 });
		const video = await ada.call("feedback.upload_attachment", { content_base64: webm() });
		expect(video).toMatchObject({ kind: "video", mime_type: "video/webm", width: null });
		const sent = await ada.call("feedback.submit", {
			...report,
			attachments: [
				{ id: image.id, token: image.token },
				{ id: video.id, token: video.token },
			],
		});
		expect(sent).toEqual({
			report_id: expect.stringMatching(/^fbr_/),
			delivery: "issue",
			issue_number: 101,
			issue_url: "https://github.com/jaredwray/soldock/issues/101",
		});
		expect(github.calls).toHaveLength(1);
		const [call] = github.calls;
		expect(call?.url).toBe(ISSUES_URL);
		expect(call?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		// The web app shows the same text before the person sends it.
		expect(call?.body).toEqual(
			buildFeedbackIssue({
				...report,
				reporter: { name: "Ada Lovelace", email: null, role: "member", kind: "human" },
				host: new URL(ORIGIN).host,
				report_id: sent.report_id,
				attachments: [
					{ kind: "image", url: image.url },
					{ kind: "video", url: video.url },
				],
			}),
		);
		const body = String(call?.body.body);
		expect(body).toContain("Ada Lovelace");
		expect(body).not.toContain(ada.address);
		expect(body).not.toContain(ada.id);
		expect(body).toContain("@​octocat");
		expect(call?.body.labels).toEqual(["bug"]);
		expect(await reportRow(sent.report_id)).toEqual({ status: "sent", issue_number: 101 });
		// The attachments are now in the report, so a second report cannot use them.
		expect(
			await codeOf(ada.call("feedback.submit", { ...report, attachments: [{ id: image.id, token: image.token }] })),
		).toBe("not_found");
	});

	it("has the address only when the person shares it", async () => {
		await turnOn();
		const github = fakeGitHub();
		await ada.call("feedback.submit", { ...report, include: { name: false, email: true } });
		const body = String(github.calls[0]?.body.body);
		expect(body).toContain(ada.address);
		expect(body).not.toContain("Ada Lovelace");
	});

	it("can come only from a person, through REST or MCP, with feedback.write", async () => {
		await turnOn();
		const github = fakeGitHub();
		expect(await codeOf(bot.call("feedback.submit", report))).toBe("forbidden");
		// MCP does not list the tool for an agent, and a call to it fails.
		const { body: tools } = await mcp(bot.key, "tools/list");
		const names = ((tools?.result ?? { tools: [] }) as { tools: { name: string }[] }).tools.map((tool) => tool.name);
		expect(names).toContain("feedback_get_status");
		expect(names).not.toContain("feedback_submit");
		expect(
			(await mcp(bot.key, "tools/call", { name: "feedback_submit", arguments: report })).body?.result,
		).toBeUndefined();
		expect((await bot.call("feedback.get_status")).can_submit).toBe(false);
		const { api_key: narrow } = await admin.call("account.create_api_key", {
			principal_id: admin.id,
			label: "mail only",
			scopes: ["account.read", "mail.read"],
		});
		expect((await api(narrow.secret)("feedback.get_status", {})).can_submit).toBe(false);
		expect(await codeOf(api(narrow.secret)("feedback.submit", report))).toBe("forbidden");
		expect(github.calls).toEqual([]);
		const viaMcp = await callTool(ada.key, "feedback_submit", report);
		expect(viaMcp.isError).toBeFalsy();
		expect(viaMcp.structuredContent).toMatchObject({ delivery: "issue", issue_number: 101 });
	});

	it("fails as unavailable when GitHub fails, and the same key tries again", async () => {
		await turnOn();
		let status = 404;
		const github = fakeGitHub(() =>
			status === 201
				? Response.json({ number: 7, html_url: "https://github.com/jaredwray/soldock/issues/7" }, { status: 201 })
				: new Response("{}", { status }),
		);
		const input = { ...report, idempotency_key: "retry-1" };
		expect(await codeOf(ada.call("feedback.submit", input))).toBe("unavailable");
		const failed = await env.DIRECTORY.prepare(
			"SELECT id, status FROM feedback_reports WHERE idempotency_key = 'retry-1'",
		).first<{ id: string; status: string }>();
		expect(failed?.status).toBe("failed");
		status = 201;
		const sent = await ada.call("feedback.submit", input);
		expect(sent).toMatchObject({ report_id: failed?.id, issue_number: 7 });
		// After success, the same key returns the same issue and sends nothing more.
		expect(await ada.call("feedback.submit", input)).toEqual(sent);
		expect(github.calls).toHaveLength(2);
	});

	it("fails as unavailable when GitHub does not answer", async () => {
		await turnOn();
		fakeGitHub(() => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		});
		expect(await codeOf(ada.call("feedback.submit", report))).toBe("unavailable");
	});

	it("stops at the limit of reports in one hour", async () => {
		await turnOn();
		const github = fakeGitHub();
		for (let i = 0; i < 5; i++) await ada.call("feedback.submit", report);
		expect(await codeOf(ada.call("feedback.submit", report))).toBe("rate_limited");
		expect(github.calls).toHaveLength(5);
		// The limit is for each person.
		expect((await admin.call("feedback.submit", report)).issue_number).toBe(106);
	});

	it("stops at the limit when the reports come at the same time", async () => {
		await turnOn();
		const github = fakeGitHub();
		const results = await Promise.all(Array.from({ length: 8 }, () => outcome(ada.call("feedback.submit", report))));
		expect(countOf(results, "ok")).toBe(5);
		expect(countOf(results, "rate_limited")).toBe(3);
		expect(github.calls).toHaveLength(5);
	});

	it("counts a failed report in the limit, and counts it again when the same key tries later", async () => {
		await turnOn();
		let status = 500;
		const github = fakeGitHub(() =>
			status === 201
				? Response.json({ number: 9, html_url: "https://github.com/jaredwray/soldock/issues/9" }, { status: 201 })
				: new Response("{}", { status }),
		);
		const old = { ...report, idempotency_key: "old-1" };
		expect(await codeOf(ada.call("feedback.submit", old))).toBe("unavailable");
		// The failed report is now two hours old, so it is not in the current hour.
		await env.DIRECTORY.prepare("UPDATE feedback_reports SET created_at = ? WHERE idempotency_key = 'old-1'")
			.bind(Date.now() - 2 * 60 * 60 * 1000)
			.run();
		for (let i = 0; i < 4; i++) expect(await codeOf(ada.call("feedback.submit", report))).toBe("unavailable");
		// The same key tries again. Its row is the fifth report of this hour.
		status = 201;
		expect((await ada.call("feedback.submit", old)).issue_number).toBe(9);
		expect(await codeOf(ada.call("feedback.submit", report))).toBe("rate_limited");
		expect(github.calls).toHaveLength(6);
	});

	it("gives conflict for a key whose report did not complete, and sends nothing", async () => {
		await turnOn();
		const github = fakeGitHub();
		// A Worker that stopped after the request to GitHub leaves a row in the state pending.
		const before = Date.now() - 10 * 60 * 1000;
		await env.DIRECTORY.prepare(
			`INSERT INTO feedback_reports (id, principal_id, kind, status, idempotency_key, created_at, updated_at)
			VALUES ('fbr_01JD3V0Y9XG8Q2W4E6R8T0Y2U4', ?, 'bug', 'pending', 'lost-1', ?, ?)`,
		)
			.bind(ada.id, before, before)
			.run();
		expect(await codeOf(ada.call("feedback.submit", { ...report, idempotency_key: "lost-1" }))).toBe("conflict");
		expect(github.calls).toEqual([]);
		expect((await reportRow("fbr_01JD3V0Y9XG8Q2W4E6R8T0Y2U4"))?.status).toBe("pending");
	});
});

describe("an attachment", () => {
	it("is a picture or a video from its bytes, never a different type", async () => {
		await turnOn();
		for (const content of [
			text("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"),
			text("<!doctype html><script>alert(1)</script>"),
			text("just text"),
		]) {
			expect(await codeOf(ada.call("feedback.upload_attachment", { name: "shot.png", content_base64: content }))).toBe(
				"invalid",
			);
		}
	});

	it("opens with no sign-in at its address, as a picture with the policy of a download", async () => {
		await turnOn();
		const image = await ada.call("feedback.upload_attachment", { content_base64: png() });
		expect(image.url).toBe(`${ORIGIN}/dl/feedback/${image.id}/${image.token}`);
		const res = await request(`/dl/feedback/${image.id}/${image.token}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
		expect(new Uint8Array(await res.arrayBuffer())[1]).toBe(0x50);
		// A wrong token and an unknown id get the same answer.
		const wrongToken = await request(`/dl/feedback/${image.id}/${"b".repeat(43)}`);
		const unknownId = await request(`/dl/feedback/fba_01JD3V0Y9XG8Q2W4E6R8T0Y2U4/${image.token}`);
		expect([wrongToken.status, unknownId.status]).toEqual([404, 404]);
		expect(await wrongToken.json()).toMatchObject({ code: "not_found", detail: "No attachment has that address." });
		// A row with no bytes in R2 gets the same answer.
		await env.BLOBS.delete(`feedback/${image.id}`);
		const noBytes = await request(`/dl/feedback/${image.id}/${image.token}`);
		const noBytesHead = await request(`/dl/feedback/${image.id}/${image.token}`, { method: "HEAD" });
		expect([noBytes.status, noBytesHead.status]).toEqual([404, 404]);
	});

	it("of a different person cannot go in a report", async () => {
		await turnOn();
		fakeGitHub();
		const image = await admin.call("feedback.upload_attachment", { content_base64: png() });
		expect(
			await codeOf(ada.call("feedback.submit", { ...report, attachments: [{ id: image.id, token: image.token }] })),
		).toBe("not_found");
		// The refused report makes no row, so it does not count in a limit.
		expect(await reportCount()).toBe(0);
	});

	it("goes away at once when its owner or an admin removes it", async () => {
		await turnOn();
		const image = await ada.call("feedback.upload_attachment", { content_base64: png() });
		const path = `/dl/feedback/${image.id}/${image.token}`;
		const other = await createActor(owner, {
			kind: "human",
			display_name: "Grace Hopper",
			address: "grace@dock.test",
			password: PASSWORD,
		});
		expect(await other.call("feedback.delete_attachment", { attachment_id: image.id })).toEqual({ deleted: false });
		expect((await request(path)).status).toBe(200);
		expect(await admin.call("feedback.delete_attachment", { attachment_id: image.id })).toEqual({ deleted: true });
		expect((await request(path)).status).toBe(404);
		expect(await env.BLOBS.head(`feedback/${image.id}`)).toBeNull();
		const mine = await ada.call("feedback.upload_attachment", { content_base64: png() });
		expect(await ada.call("feedback.delete_attachment", { attachment_id: mine.id })).toEqual({ deleted: true });
	});

	it("stops at the limit of attachments that no report holds", async () => {
		await turnOn();
		for (let i = 0; i < 10; i++) await ada.call("feedback.upload_attachment", { content_base64: png() });
		expect(await codeOf(ada.call("feedback.upload_attachment", { content_base64: png() }))).toBe("rate_limited");
	});

	it("stops at the same limit when the uploads come at the same time", async () => {
		await turnOn();
		const results = await Promise.all(
			Array.from({ length: 12 }, () => outcome(ada.call("feedback.upload_attachment", { content_base64: png() }))),
		);
		expect(countOf(results, "ok")).toBe(10);
		expect(countOf(results, "rate_limited")).toBe(2);
		const rows = await env.DIRECTORY.prepare("SELECT COUNT(*) AS n FROM feedback_attachments").first<number>("n");
		expect(rows).toBe(10);
	});

	it("goes away after its time: 24 hours without a report, 180 days in a report", async () => {
		await turnOn();
		fakeGitHub();
		const old = await ada.call("feedback.upload_attachment", { content_base64: png() });
		const fresh = await ada.call("feedback.upload_attachment", { content_base64: png() });
		const sent = await ada.call("feedback.upload_attachment", { content_base64: png() });
		await ada.call("feedback.submit", { ...report, attachments: [{ id: sent.id, token: sent.token }] });
		const now = Date.now();
		await env.DIRECTORY.prepare("UPDATE feedback_attachments SET created_at = ? WHERE id = ?")
			.bind(now - 25 * 60 * 60 * 1000, old.id)
			.run();
		await runScheduled(env, now);
		expect((await request(`/dl/feedback/${old.id}/${old.token}`)).status).toBe(404);
		expect(await env.BLOBS.head(`feedback/${old.id}`)).toBeNull();
		expect((await request(`/dl/feedback/${fresh.id}/${fresh.token}`)).status).toBe(200);
		expect((await request(`/dl/feedback/${sent.id}/${sent.token}`)).status).toBe(200);
		await runScheduled(env, now + 181 * 24 * 60 * 60 * 1000);
		expect((await request(`/dl/feedback/${sent.id}/${sent.token}`)).status).toBe(404);
	});
});
