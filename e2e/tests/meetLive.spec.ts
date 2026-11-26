import { appendFileSync } from "node:fs";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { createMeeting, expectMediaFlows, launchMediaBrowser, mediaContext, signInMedia } from "../support/meet.ts";

// The paths of the network to Cloudflare Realtime. Only the live-meet workflow runs this file (MEET_LIVE=1): the
// stand-in SFU of a pull request has no TURN server. Each test writes the candidate types of the selected ICE
// pair to MEET_LIVE_REPORT, and the workflow puts them in its job summary.

const LIVE = process.env.MEET_LIVE === "1";
test.skip(!LIVE, "Only the live-meet workflow runs the tests against Cloudflare Realtime.");

/** Makes each connection of the page use only TURN relay candidates. */
const RELAY_ONLY = `
(() => {
	const Original = window.RTCPeerConnection;
	window.RTCPeerConnection = class extends Original {
		constructor(config = {}, ...rest) {
			super({ ...config, iceTransportPolicy: "relay" }, ...rest);
		}
	};
})();
`;

async function selectedPair(page: Page): Promise<{ local: string; remote: string; protocol: string } | null> {
	return page.evaluate(async () => {
		const list = (window as unknown as { __meetConnections?: RTCPeerConnection[] }).__meetConnections ?? [];
		for (const pc of list.filter((item) => item.connectionState === "connected")) {
			const stats = await pc.getStats();
			const byId = new Map<string, Record<string, unknown>>();
			stats.forEach((report: Record<string, unknown>) => {
				byId.set(report.id as string, report);
			});
			for (const report of byId.values()) {
				if (report.type !== "transport" || typeof report.selectedCandidatePairId !== "string") continue;
				const pair = byId.get(report.selectedCandidatePairId);
				const local = pair ? byId.get(pair.localCandidateId as string) : undefined;
				const remote = pair ? byId.get(pair.remoteCandidateId as string) : undefined;
				if (local && remote) {
					return {
						local: String(local.candidateType),
						remote: String(remote.candidateType),
						protocol: String(local.protocol),
					};
				}
			}
		}
		return null;
	});
}

function report(path: string, result: unknown): void {
	const file = process.env.MEET_LIVE_REPORT;
	if (file) appendFileSync(file, `${JSON.stringify({ path, result })}\n`);
}

let browser: Browser;
test.beforeAll(async () => {
	browser = await launchMediaBrowser();
});
test.afterAll(async () => {
	await browser?.close();
});

async function call(title: string, guestScript: string | null) {
	const hostContext = await signInMedia(browser, "nadia");
	const meeting = await createMeeting(hostContext, title);
	const host = await hostContext.newPage();
	await host.goto(`/meet/${meeting.code}`);
	await host.getByRole("button", { name: "Start the meeting" }).click();
	const guestContext = await mediaContext(browser);
	if (guestScript) await guestContext.addInitScript(guestScript);
	const guest = await guestContext.newPage();
	await guest.goto(`/meet/${meeting.code}`);
	await guest.getByLabel("Your name").fill("Live Guest");
	await guest.getByRole("button", { name: "Ask to join" }).click();
	await host.getByRole("button", { name: "Admit Live Guest" }).click();
	await expectMediaFlows(guest);
	await expectMediaFlows(host);
	return { host, guest, close: () => Promise.all([hostContext.close(), guestContext.close()]) };
}

test("media flows over the default path to the SFU", async () => {
	const { guest, close } = await call("Live direct", null);
	const pair = await selectedPair(guest);
	report("default", pair);
	expect(pair).not.toBeNull();
	await close();
});

test("media flows over the TURN relay of Cloudflare", async () => {
	const { guest, close } = await call("Live relay", RELAY_ONLY);
	const pair = await selectedPair(guest);
	report("turn-relay", pair);
	expect(pair?.local).toBe("relay");
	await close();
});
