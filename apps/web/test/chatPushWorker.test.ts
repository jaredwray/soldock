import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

// Run the script that the browser registers. The handlers get only the service worker APIs that they use.
const script = readFileSync(new URL("../public/chat-push.js", import.meta.url), "utf8");
const origin = "https://chat.example";
const message = { principal_id: "prn_one", room_id: "rm_one", seq: 12, parent_seq: 8, unread_count: 7, sound: false };

const reminder = {
	kind: "calendar_reminder",
	principal_id: "prn_one",
	reminder_id: "calrem:evt_01HZZZZZZZZZZZZZZZZZZZZZZZ:20301105T190000Z:1920049200000",
	event_id: "evt_01HZZZZZZZZZZZZZZZZZZZZZZZ",
	occurrence_id: "evt_01HZZZZZZZZZZZZZZZZZZZZZZZ_20301105T170000Z",
	start: "2030-11-05T19:00:00.000Z",
	minutes: 10,
	sound: true,
};

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

it("shows a calendar reminder with its id as the tag, and opens the week of the event", async () => {
	const sw = worker();
	await sw.push(reminder);
	await sw.push(reminder);
	const [title, options] = sw.show.mock.calls[0] ?? [];
	expect(title).toBe("Event reminder");
	expect(options?.tag).toBe(reminder.reminder_id);
	// A second delivery has the same tag, so the device replaces the first notification.
	expect(sw.show.mock.calls.map(([, shown]) => shown.tag)).toEqual([reminder.reminder_id, reminder.reminder_id]);
	expect(sw.setAppBadge).not.toHaveBeenCalled();
	if (!options) throw new Error("The worker did not show the reminder.");
	await sw.click(options);
	expect(sw.openWindow.mock.calls[0]?.[0]).toMatch(new RegExp(`^${origin}/calendar/week/2030-11-0[45]$`));
});

it("ignores a calendar reminder for a different account", async () => {
	const sw = worker();
	await sw.push({ ...reminder, principal_id: "prn_other" });
	expect(sw.show).not.toHaveBeenCalled();
});
