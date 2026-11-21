import { afterEach, expect, it, vi } from "vitest";
import { setAccount } from "../src/lib/account.ts";
import { devicePushEnabled, enableDevicePush, syncPushDevices } from "../src/lib/chatPush.ts";

const origin = "https://chat.example";
const account = "prn_one";
const notifications = "/api/v1/chat/notifications";
const devices = "/api/v1/chat/push-subscriptions";
const previousKey = new Uint8Array([4, 1]);
const nextKey = new Uint8Array([4, 2]);
const publicKey = btoa(String.fromCharCode(...nextKey)).replaceAll("=", "");

afterEach(() => {
	setAccount(null);
	vi.unstubAllGlobals();
});

/** A device that opted in with the previous key. Its next endpoint belongs to the new key. */
function signedInDevice() {
	const previous = "https://push.example/old";
	const replacement = "https://push.example/new";
	const registered = new Set([previous]);
	function subscription(endpoint: string, key: ArrayBuffer) {
		return {
			endpoint,
			options: { applicationServerKey: key },
			toJSON: () => ({ keys: { p256dh: "encryption-key", auth: "secret" } }),
			async unsubscribe() {
				current = null;
				return true;
			},
		};
	}
	let current: ReturnType<typeof subscription> | null = subscription(previous, previousKey.buffer);
	const subscribe = vi.fn(async (options: PushSubscriptionOptionsInit) => {
		expect(options.userVisibleOnly).toBe(true);
		expect(options.applicationServerKey).toEqual(nextKey);
		if (current) throw new Error("A subscription for the previous key still exists.");
		current = subscription(replacement, nextKey.buffer);
		return current;
	});
	const registration = {
		active: {},
		scope: `${origin}/chat-push/${account}/`,
		pushManager: { getSubscription: async () => current, subscribe },
	};
	const requestPermission = vi.fn(async () => "granted");
	vi.stubGlobal("Notification", { permission: "granted", requestPermission });
	vi.stubGlobal("window", { PushManager: {}, Notification });
	vi.stubGlobal("location", new URL(origin));
	vi.stubGlobal("navigator", {
		serviceWorker: {
			getRegistrations: async () => [registration],
			getRegistration: async () => registration,
			register: async () => registration,
		},
	});
	vi.stubGlobal("fetch", async (path: string, req: RequestInit) => {
		if (path === notifications) return Response.json({ vapid_public_key: publicKey });
		const change = JSON.parse(String(req.body));
		expect(change.expected_principal_id).toBe(account);
		if (path === devices) {
			registered.add(change.endpoint);
			return Response.json({ subscribed: true });
		}
		if (path === `${devices}/remove`) return Response.json({ deleted: registered.delete(change.endpoint) });
		throw new Error(`Unexpected operation: ${path}`);
	});
	setAccount(account);
	return { registered, replacement, subscribe, requestPermission };
}

it("restores device delivery after the server rotates its VAPID key", async () => {
	const device = signedInDevice();
	await syncPushDevices(account);
	expect([...device.registered]).toEqual([device.replacement]);
	expect(await devicePushEnabled(account, publicKey)).toBe(true);
	expect(device.requestPermission).not.toHaveBeenCalled();
});

it("reports a failed automatic renewal and lets the person enable push again", async () => {
	const device = signedInDevice();
	device.subscribe.mockRejectedValueOnce(new Error("Push service unavailable"));
	const start = syncPushDevices(account);
	const status = devicePushEnabled(account, publicKey);
	await Promise.all([
		expect(start).rejects.toThrow("Push service unavailable"),
		expect(status).rejects.toThrow("Push service unavailable"),
	]);
	expect(device.registered.size).toBe(0);
	expect(device.requestPermission).not.toHaveBeenCalled();
	await enableDevicePush(account, publicKey);
	expect(await devicePushEnabled(account, publicKey)).toBe(true);
	expect([...device.registered]).toEqual([device.replacement]);
});
