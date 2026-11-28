import { type Browser, type BrowserContext, chromium, expect, type Page } from "@playwright/test";
import { LOCAL_WEBRTC_FLAGS } from "./fake-sfu.ts";
import { BASE_URL } from "./server.ts";

// Helpers of the Meet tests. Each participant has its own browser, as two people on two computers have. Chromium
// gives each page a synthetic camera and microphone (`--use-fake-device-for-media-stream`).

/** Records each RTCPeerConnection of the page, so a test can read its statistics. The app has no hook for it. */
const RECORD_CONNECTIONS = `
(() => {
	const Original = window.RTCPeerConnection;
	if (!Original) return;
	window.__meetConnections = [];
	window.RTCPeerConnection = class extends Original {
		constructor(...args) {
			super(...args);
			window.__meetConnections.push(this);
		}
	};
})();
`;

export interface MediaBrowserOptions {
	/**
	 * `allow`: the browser gives the synthetic devices with no prompt. `ask`: no answer to the prompt, so only the
	 * permissions that the test grants work.
	 */
	prompt?: "allow" | "ask";
}

/** A browser with synthetic media devices. */
export async function launchMediaBrowser(options: MediaBrowserOptions = {}): Promise<Browser> {
	const args = [
		"--use-fake-device-for-media-stream",
		"--autoplay-policy=no-user-gesture-required",
		...LOCAL_WEBRTC_FLAGS,
	];
	if ((options.prompt ?? "allow") === "allow") {
		args.push("--use-fake-ui-for-media-stream");
		return chromium.launch({ args });
	}
	// The headless shell refuses each device without the fake prompt. The new headless mode of Chromium follows the
	// permissions of the context: a granted microphone works, and the camera prompt gets no answer, so it fails.
	return chromium.launch({ channel: "chromium", args });
}

/** A new context of a media browser, with the recorder of connections. */
export async function mediaContext(
	browser: Browser,
	options: Parameters<Browser["newContext"]>[0] = {},
): Promise<BrowserContext> {
	const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1200, height: 800 }, ...options });
	await context.addInitScript(RECORD_CONNECTIONS);
	return context;
}

/** Signs a person of the seed data in, in a context of a media browser. */
export async function signInMedia(
	browser: Browser,
	person: string,
	options: Parameters<Browser["newContext"]>[0] = {},
) {
	const context = await mediaContext(browser, options);
	const response = await context.request.post("/auth/session", {
		headers: { origin: BASE_URL, "content-type": "application/json" },
		data: { address: `${person}@example.com`, password: `${person} local password` },
	});
	expect(response.status(), `sign-in of ${person}`).toBe(200);
	return context;
}

/** Creates a meeting as the person of the context. Returns its code and its link. */
export async function createMeeting(context: BrowserContext, title: string) {
	const response = await context.request.post("/api/v1/meet/meetings", {
		headers: { origin: BASE_URL, "content-type": "application/json" },
		data: { title },
	});
	expect(response.ok(), await response.text()).toBe(true);
	const { meeting } = (await response.json()) as { meeting: { code: string; join_url: string } };
	return meeting;
}

export interface Inbound {
	audioBytes: number;
	videoBytes: number;
	framesDecoded: number;
	connections: number;
}

/** The media that the page received, over each of its connections. */
export async function inbound(page: Page): Promise<Inbound> {
	return page.evaluate(async () => {
		const list = ((window as unknown as { __meetConnections?: RTCPeerConnection[] }).__meetConnections ?? []).filter(
			(pc) => pc.connectionState !== "closed",
		);
		const total = { audioBytes: 0, videoBytes: 0, framesDecoded: 0, connections: list.length };
		for (const pc of list) {
			const stats = await pc.getStats();
			stats.forEach((report: { type: string; kind?: string; bytesReceived?: number; framesDecoded?: number }) => {
				if (report.type !== "inbound-rtp") return;
				if (report.kind === "audio") total.audioBytes += report.bytesReceived ?? 0;
				if (report.kind === "video") {
					total.videoBytes += report.bytesReceived ?? 0;
					total.framesDecoded += report.framesDecoded ?? 0;
				}
			});
		}
		return total;
	});
}

/** The number of connections that the page made, also the closed ones. */
export async function connectionCount(page: Page): Promise<number> {
	return page.evaluate(
		() => ((window as unknown as { __meetConnections?: RTCPeerConnection[] }).__meetConnections ?? []).length,
	);
}

/** Waits until audio and video arrive and grow on the page. */
export async function expectMediaFlows(page: Page, what: { audio?: boolean; video?: boolean } = {}): Promise<void> {
	const audio = what.audio ?? true;
	const video = what.video ?? true;
	const first = await expect
		.poll(
			async () => {
				const now = await inbound(page);
				return (!audio || now.audioBytes > 0) && (!video || now.framesDecoded > 0);
			},
			{ timeout: 20_000 },
		)
		.toBe(true)
		.then(() => inbound(page));
	await expect
		.poll(
			async () => {
				const now = await inbound(page);
				return (!audio || now.audioBytes > first.audioBytes) && (!video || now.videoBytes > first.videoBytes);
			},
			{ timeout: 10_000 },
		)
		.toBe(true);
}

/** Checks that no media arrives on the page for a while. */
export async function expectMediaStopped(page: Page): Promise<void> {
	// The last packets in flight can still arrive at the start.
	await page.waitForTimeout(1500);
	const before = await inbound(page);
	await page.waitForTimeout(2500);
	const after = await inbound(page);
	expect(after.audioBytes - before.audioBytes, "audio bytes after the cut").toBeLessThan(300);
	expect(after.videoBytes - before.videoBytes, "video bytes after the cut").toBeLessThan(1000);
}

/** The participant token that the page of a meeting keeps in sessionStorage. */
export async function tokenOf(page: Page, code: string): Promise<string> {
	const token = await page.evaluate((key) => window.sessionStorage.getItem(key), `asterra.meet.${code}`);
	expect(token).toBeTruthy();
	return token as string;
}

/** A call route of a meeting with a participant token, as a script on the page of the guest could send it. */
export async function callRoute(page: Page, code: string, path: string, token: string, body: unknown = {}) {
	return page.request.post(`/api/v1/meet/calls/${code}${path}`, {
		headers: { "content-type": "application/json", "x-asterra-meet-token": token },
		data: body,
	});
}
