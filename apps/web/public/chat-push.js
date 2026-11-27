// The registration scope identifies the person who enabled notifications on this device.
function messagePath(data) {
	if (!data || !/^(rm|dm)_[A-Za-z0-9_-]+$/.test(data.room_id)) return null;
	const scope = new URL(self.registration.scope);
	if (scope.pathname !== `/chat-push/${encodeURIComponent(data.principal_id)}/`) return null;
	const seq = (n) => Number.isSafeInteger(n) && n > 0;
	if (!seq(data.seq) || (data.parent_seq !== null && !seq(data.parent_seq))) return null;
	const path = `/chat/${data.room_id}`;
	return data.parent_seq === null ? `${path}/${data.seq}` : `${path}/${data.parent_seq}/${data.seq}`;
}

// A calendar reminder has no title: it tells the time of the start and opens the week of the event.
function reminderPath(data) {
	if (!data || data.kind !== "calendar_reminder" || !/^evt_[A-Z0-9]{26}$/.test(data.event_id)) return null;
	const scope = new URL(self.registration.scope);
	if (scope.pathname !== `/chat-push/${encodeURIComponent(data.principal_id)}/`) return null;
	const start = Date.parse(data.start);
	if (Number.isNaN(start)) return null;
	const date = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(start);
	return `/calendar/week/${date}`;
}

self.addEventListener("push", (event) => {
	if (!event.data) return;
	let message;
	try {
		message = event.data.json();
	} catch {
		return;
	}
	const reminder = reminderPath(message);
	if (reminder) {
		event.waitUntil(showReminder(message));
		return;
	}
	const path = messagePath(message);
	if (!path) return;
	event.waitUntil(showMessage(message, path));
});

async function showReminder(message) {
	const time = new Date(message.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	await self.registration.showNotification("Event reminder", {
		body: `An event starts at ${time}.`,
		icon: "/icon-192.png",
		// The tag is the id of the reminder, so a second delivery replaces the first.
		tag: typeof message.reminder_id === "string" ? message.reminder_id : message.event_id,
		silent: !message.sound,
		data: message,
	});
}

async function showMessage(message, path) {
	const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
	// Older pushes omit foreground_sound. Those use the previous focus check.
	const focused = windows.some((client) => client.focused && client.visibilityState === "visible");
	const badge =
		Number.isSafeInteger(message.unread_count) && message.unread_count >= 0
			? self.navigator.setAppBadge?.(message.unread_count).catch(() => {})
			: undefined;
	await Promise.all([
		badge,
		self.registration.showNotification("New chat message", {
			body: "Open the message in Asterra.",
			icon: "/icon-192.png",
			tag: path,
			silent: !message.sound || (message.foreground_sound !== false && focused),
			data: message,
		}),
	]);
}

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const path = reminderPath(event.notification.data) ?? messagePath(event.notification.data);
	if (!path) return;
	event.waitUntil(
		(async () => {
			const target = new URL(path, self.location.origin).href;
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			const open = windows.find((client) => client.url === target);
			if (open) await open.focus();
			else await self.clients.openWindow(target);
		})(),
	);
});
