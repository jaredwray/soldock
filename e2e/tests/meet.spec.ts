import { type Browser, devices, expect, type Page, test } from "@playwright/test";
import { FAKE_SFU_BASE } from "../support/fake-sfu.ts";
import {
	callRoute,
	connectionCount,
	createMeeting,
	expectMediaFlows,
	expectMediaStopped,
	inbound,
	launchMediaBrowser,
	mediaContext,
	signInMedia,
	tokenOf,
} from "../support/meet.ts";

// Meet with two browsers: a host of the seed data and a guest with no account. Each browser has a synthetic
// camera and microphone. Without credentials, the Worker sends the media through the stand-in SFU of
// support/fake-sfu.ts. The live-meet workflow runs these tests against Cloudflare Realtime (MEET_LIVE=1).

const LIVE = process.env.MEET_LIVE === "1";

let hostBrowser: Browser;
let guestBrowser: Browser;

test.beforeAll(async () => {
	hostBrowser = await launchMediaBrowser();
	guestBrowser = await launchMediaBrowser();
});

test.afterAll(async () => {
	await hostBrowser?.close();
	await guestBrowser?.close();
});

/** The host signs in, creates a meeting and starts it. */
async function startAsHost(title: string) {
	const context = await signInMedia(hostBrowser, "nadia");
	const meeting = await createMeeting(context, title);
	const page = await context.newPage();
	await page.goto(`/meet/${meeting.code}`);
	await expect(page.getByRole("heading", { name: title })).toBeVisible();
	await page.getByRole("button", { name: "Start the meeting" }).click();
	await expect(page.getByRole("button", { name: "Leave call" })).toBeVisible();
	return { context, page, meeting };
}

/**
 * A gate between the page of a guest and the server. While it is shut, the page gets no message of the meeting
 * socket and no state, as a page that ignores the server. The server must still cut it off.
 */
interface Gate {
	shut: boolean;
}

/** A guest opens the link, enters a name and asks to join. */
async function askAsGuest(
	browser: Browser,
	code: string,
	name: string,
	options: Parameters<Browser["newContext"]>[0] = {},
	gate?: Gate,
) {
	const context = await mediaContext(browser, options);
	const page = await context.newPage();
	if (gate) {
		await page.routeWebSocket(/\/ws\/meet\//, (ws) => {
			const server = ws.connectToServer();
			server.onMessage((message) => {
				if (!gate.shut) ws.send(message);
			});
			ws.onMessage((message) => server.send(message));
			const closeOptions = (closeCode?: number, reason?: string) => ({
				...(closeCode === undefined ? {} : { code: closeCode }),
				...(reason === undefined ? {} : { reason }),
			});
			server.onClose((closeCode, reason) => {
				if (!gate.shut) void ws.close(closeOptions(closeCode, reason));
			});
			ws.onClose((closeCode, reason) => void server.close(closeOptions(closeCode, reason)));
		});
		await page.route("**/api/v1/meet/calls/*/state", (route) => (gate.shut ? route.abort() : route.continue()));
	}
	await page.goto(`/meet/${code}`);
	await page.getByLabel("Your name").fill(name);
	await page.getByRole("button", { name: "Ask to join" }).click();
	await expect(page.getByText(/Waiting for .* to let you in/)).toBeVisible();
	return { context, page };
}

async function admit(host: Page, name: string) {
	await expect(host.getByRole("complementary", { name: "Waiting to join" })).toContainText(name);
	await host.getByRole("button", { name: `Admit ${name}` }).click();
}

async function remoteVideoWidth(page: Page, name: string): Promise<number> {
	return page
		.getByRole("figure")
		.filter({ hasText: name })
		.locator("video")
		.evaluate((video: HTMLVideoElement) => video.videoWidth)
		.catch(() => 0);
}

test("a guest gets no media in the lobby, media after the admit, and none after the host removes it", async () => {
	const host = await startAsHost("Design review");
	const gate: Gate = { shut: false };
	const guest = await askAsGuest(guestBrowser, host.meeting.code, "Grace Guest", {}, gate);

	// In the lobby: the page has no connection, and the token cannot start media.
	expect(await connectionCount(guest.page)).toBe(0);
	const token = await tokenOf(guest.page, host.meeting.code);
	expect((await callRoute(guest.page, host.meeting.code, "/media/session", token)).status()).toBe(403);

	// The admit starts the call. Audio and video flow in both directions.
	await admit(host.page, "Grace Guest");
	await expect(guest.page.getByRole("button", { name: "Leave call" })).toBeVisible();
	await expectMediaFlows(guest.page);
	await expectMediaFlows(host.page);
	await expect.poll(() => remoteVideoWidth(guest.page, "Nadia")).toBeGreaterThan(0);
	await expect.poll(() => remoteVideoWidth(host.page, "Grace Guest")).toBeGreaterThan(0);

	// Mute shows on the other side.
	await guest.page.getByRole("button", { name: "Mute" }).click();
	await expect(
		host.page.getByRole("figure").filter({ hasText: "Grace Guest" }).locator(".meet-tile-muted"),
	).toBeVisible();
	await guest.page.getByRole("button", { name: "Unmute" }).click();
	await expect(
		host.page.getByRole("figure").filter({ hasText: "Grace Guest" }).locator(".meet-tile-muted"),
	).toHaveCount(0);

	// Video off and on: the tile shows the initials, then the video again.
	await guest.page.getByRole("button", { name: "Turn off camera" }).click();
	await expect(host.page.getByRole("figure").filter({ hasText: "Grace Guest" }).locator("video")).toHaveCount(0);
	await guest.page.getByRole("button", { name: "Turn on camera" }).click();
	await expect.poll(() => remoteVideoWidth(host.page, "Grace Guest"), { timeout: 20_000 }).toBeGreaterThan(0);

	// The guest page stops hearing from the server, as a page that ignores the removal. The server still cuts it off.
	gate.shut = true;
	await host.page.getByRole("button", { name: "Remove Grace Guest" }).click();
	await expect(host.page.getByRole("figure").filter({ hasText: "Grace Guest" })).toHaveCount(0);
	await expectMediaStopped(guest.page);
	await expectMediaStopped(host.page);
	expect((await callRoute(guest.page, host.meeting.code, "/media/session", token)).status()).toBe(403);
	const subscribe = await callRoute(guest.page, host.meeting.code, "/media/subscribe", token, {
		session: 1,
		track_ids: ["trk_x"],
	});
	expect(subscribe.status()).toBe(403);

	await host.context.close();
	await guest.context.close();
});

test("the host ends the call: each participant leaves, and nobody joins again", async () => {
	const host = await startAsHost("Weekly sync");
	const guest = await askAsGuest(guestBrowser, host.meeting.code, "Ellis Guest");
	await admit(host.page, "Ellis Guest");
	await expectMediaFlows(guest.page);

	await host.page.getByRole("button", { name: "End call for everyone" }).click();
	await host.page.getByRole("dialog").getByRole("button", { name: "End call" }).click();
	await expect(host.page.getByRole("heading", { name: "The meeting ended" })).toBeVisible();
	await expect(guest.page.getByRole("heading", { name: "The meeting ended" })).toBeVisible();
	await expectMediaStopped(guest.page);

	const late = await mediaContext(guestBrowser);
	const latePage = await late.newPage();
	await latePage.goto(`/meet/${host.meeting.code}`);
	await expect(latePage.getByRole("heading", { name: "The meeting ended" })).toBeVisible();
	await expect(latePage.getByLabel("Your name")).toHaveCount(0);
	await host.context.close();
	await guest.context.close();
	await late.close();
});

test("a guest reconnects after a reload and after a lost connection, without the lobby", async () => {
	test.skip(LIVE, "The live run cannot drop a session of the real SFU.");
	const host = await startAsHost("Reconnect check");
	const guest = await askAsGuest(guestBrowser, host.meeting.code, "Remy Guest");
	await admit(host.page, "Remy Guest");
	await expectMediaFlows(guest.page);

	// A reload keeps the token of the tab: the guest joins again with one click, and the host does not admit again.
	await guest.page.reload();
	await guest.page.getByRole("button", { name: "Rejoin" }).click();
	await expect(guest.page.getByRole("button", { name: "Leave call" })).toBeVisible();
	await expectMediaFlows(guest.page);
	await expectMediaFlows(host.page);

	// The SFU side of the connection of the guest closes, as on a lost network. The page starts a new session.
	const state = await guest.page.request.get(`/api/v1/meet/calls/${host.meeting.code}/state`, {
		headers: { "x-asterra-meet-token": await tokenOf(guest.page, host.meeting.code) },
	});
	const participantId = ((await state.json()) as { self: { id: string } }).self.id;
	const before = await connectionCount(guest.page);
	const dropped = await guest.page.request.post(`${FAKE_SFU_BASE.replace(/\/v1$/, "")}/test/drop`, {
		data: { prefix: participantId },
	});
	// The session from before the reload is still in the stand-in, which keeps old sessions as the SFU keeps them for a while.
	expect(((await dropped.json()) as { dropped: number }).dropped).toBeGreaterThanOrEqual(1);
	await expect.poll(() => connectionCount(guest.page), { timeout: 45_000 }).toBeGreaterThan(before);
	await expectMediaFlows(guest.page);
	await expectMediaFlows(host.page);
	await host.context.close();
	await guest.context.close();
});

test("a guest on a phone without a camera joins with audio, and a guest with no devices can listen", async () => {
	const host = await startAsHost("Phone check");
	// A phone that allows the microphone and refuses the camera.
	const phoneBrowser = await launchMediaBrowser({ prompt: "ask" });
	try {
		const phone = await mediaContext(phoneBrowser, { ...devices["Pixel 7"], permissions: ["microphone"] });
		const page = await phone.newPage();
		await page.goto(`/meet/${host.meeting.code}`);
		await expect(page.getByText("You can join with audio only.")).toBeVisible();
		await page.getByLabel("Your name").fill("Pat Phone");
		await page.getByRole("button", { name: "Ask to join" }).click();
		await admit(host.page, "Pat Phone");
		await expect(page.getByRole("button", { name: "Leave call" })).toBeVisible();
		await expectMediaFlows(page);
		await expectMediaFlows(host.page, { video: false });
		await expect(host.page.getByRole("figure").filter({ hasText: "Pat Phone" }).locator("video")).toHaveCount(0);

		// A browser that refuses both devices joins to listen and watch. The host refuses it here.
		const quiet = await mediaContext(phoneBrowser);
		const quietPage = await quiet.newPage();
		await quietPage.goto(`/meet/${host.meeting.code}`);
		await expect(quietPage.getByText(/You can join to listen and watch/).first()).toBeVisible();
		await quietPage.getByLabel("Your name").fill("Lee Listener");
		await quietPage.getByRole("button", { name: "Ask to join" }).click();
		await expect(host.page.getByRole("complementary", { name: "Waiting to join" })).toContainText("Lee Listener");
		await host.page.getByRole("button", { name: "Deny Lee Listener" }).click();
		await expect(quietPage.getByRole("heading", { name: "The host did not let you in" })).toBeVisible();
		expect(await inbound(quietPage)).toMatchObject({ audioBytes: 0, videoBytes: 0 });
	} finally {
		await phoneBrowser.close();
		await host.context.close();
	}
});
