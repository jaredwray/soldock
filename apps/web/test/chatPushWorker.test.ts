import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

// Run the script that the browser registers. The handlers get only the service worker APIs that they use.
const script = readFileSync(new URL("../public/chat-push.js", import.meta.url), "utf8");
const origin = "https://chat.example";
const message = { principal_id: "prn_one", room_id: "rm_one", seq: 12, parent_seq: 8, unread_count: 7, sound: false };

function worker() {
	const handlers = new Map<string, (event: object) => void>();
	const show = vi.fn(async (_title: string, _options: NotificationOptions) => {});
	const openWindow = vi.fn();
	const focus = vi.fn();
	const setAppBadge = vi.fn(async () => {});
	let windows: { url: string; focus: typeof focus; focused: boolean; visibilityState: string }[] = [];
	runInNewContext(script, {
		URL,
		self: {
			location: { origin },
			registration: { scope: `${origin}/chat-push/prn_one/`, showNotification: show },
			navigator: { setAppBadge },
			clients: { matchAll: async () => windows, openWindow },
			addEventListener: (name: string, fn: (event: object) => void) => handlers.set(name, fn),
		},
	});
	async function emit(type: string, event: object) {
		let pending: Promise<unknown> | undefined;
		handlers.get(type)?.({
			...event,
			waitUntil: (promise: Promise<unknown>) => {
				pending = promise;
			},
		});
		await pending;
	}
	return {
		show,
		openWindow,
		focus,
		setAppBadge,
		push: (data: object) => emit("push", { data: { json: () => data } }),
		click: (notification: NotificationOptions) =>
			emit("notificationclick", { notification: { ...notification, close: () => {} } }),
		openTab(url: string) {
			windows = [{ url, focus, focused: true, visibilityState: "visible" }];
		},
	};
}

it("a quiet push updates the badge and opens its reply from the notification", async () => {
	const sw = worker();
	await sw.push(message);
	expect(sw.setAppBadge).toHaveBeenCalledWith(7);
	const notification = sw.show.mock.calls[0]?.[1];
	expect(notification?.silent).toBe(true);
	if (!notification) throw new Error("The worker did not show the notification.");
	const target = `${origin}/chat/rm_one/8/12`;
	await sw.click(notification);
	expect(sw.openWindow).toHaveBeenCalledExactlyOnceWith(target);
	sw.openTab(target);
	await sw.click(notification);
	expect(sw.focus).toHaveBeenCalledOnce();
	expect(sw.openWindow).toHaveBeenCalledTimes(1);
});

it("keeps the system sound on a focused device that did not receive the foreground sound", async () => {
	const sw = worker();
	sw.openTab(origin);
	await sw.push({ ...message, sound: true, foreground_sound: false });
	await sw.push({ ...message, sound: true, foreground_sound: true });
	// A push from an older Worker uses the previous rule for a focused tab.
	await sw.push({ ...message, sound: true });
	expect(sw.show.mock.calls.map(([, options]) => options.silent)).toEqual([false, true, true]);
});

it("a device ignores a push for a different account", async () => {
	const sw = worker();
	await sw.push({ ...message, principal_id: "prn_other" });
	expect(sw.setAppBadge).not.toHaveBeenCalled();
	expect(sw.show).not.toHaveBeenCalled();
});
