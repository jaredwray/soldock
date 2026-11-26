import { type BrowserContext, expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

// Live calendar updates: two sessions of the organizer and one of the teammate keep the week open. A change
// shows without a reload and without the wait of a poll: the events socket sends `calendar.changed`, and the
// page reads `calendar.list_changes` from its cursor. One session then loses its socket and its network, the
// organizer edits, and the session catches up from its cursor when it connects again.
test.use({ timezoneId: "America/New_York" });

/** A random day of February in a far year: New York has no change of the clock in February. */
function farDay(): string {
	const year = 2090 + Math.floor(Math.random() * 10);
	const day = 1 + Math.floor(Math.random() * 28);
	return `${year}-02-${String(day).padStart(2, "0")}`;
}

/** A time on the day in New York (UTC-5 in February). */
const at = (day: string, time: string) => `${day}T${time}:00-05:00`;

async function openWeek(page: Page, day: string) {
	await page.goto(`/calendar/week/${day}`);
	await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();
}

async function api<T>(context: BrowserContext, method: "POST" | "DELETE", path: string, data?: unknown): Promise<T> {
	const response = await context.request.fetch(path, {
		method,
		...(data === undefined ? {} : { data }),
		headers: { origin: BASE_URL, "content-type": "application/json" },
	});
	expect(response.ok(), await response.text()).toBe(true);
	return (await response.json()) as T;
}

/**
 * Puts a proxy between the page and its events socket, so the test can cut the socket. While `cut`, a new socket
 * closes at once, as when the network is down.
 */
async function cuttableSocket(page: Page) {
	let cut = false;
	const open = new Set<WebSocketRoute>();
	await page.routeWebSocket(/\/ws\/events$/, (socket) => {
		if (cut) {
			void socket.close({ code: 1006 });
			return;
		}
		socket.connectToServer();
		open.add(socket);
	});
	return {
		async cut() {
			cut = true;
			for (const socket of open) await socket.close({ code: 1006 });
			open.clear();
		},
		restore() {
			cut = false;
		},
	};
}

test("each open calendar updates live, and a session that was offline catches up from its cursor", async ({
	browser,
}) => {
	const organizer = await signIn(browser, "nadia");
	const second = await signIn(browser, "nadia");
	const teammate = await signIn(browser, "chidi");
	try {
		const day = farDay();
		const title = unique("Live review");
		const [organizerPage, secondPage, teammatePage] = await Promise.all([
			organizer.newPage(),
			second.newPage(),
			teammate.newPage(),
		]);
		const socket = await cuttableSocket(secondPage);
		await Promise.all([openWeek(organizerPage, day), openWeek(secondPage, day), openWeek(teammatePage, day)]);

		// The organizer invites the teammate. Each open page shows the meeting without a reload.
		const { event } = await api<{ event: { id: string; revision: number } }>(
			organizer,
			"POST",
			"/api/v1/calendar/events",
			{
				title,
				when: { kind: "timed", start: at(day, "10:00"), end: at(day, "11:00"), time_zone: "America/New_York" },
				attendees: [{ email: "chidi@example.com" }],
			},
		);
		await expect(secondPage.getByRole("button", { name: `${title}, 10:00 AM – 11:00 AM` })).toHaveCount(1);
		const pending = teammatePage.getByRole("button", {
			name: `${title}, 10:00 AM – 11:00 AM, invitation, not answered`,
		});
		await expect(pending).toHaveCount(1);

		// The teammate accepts in the page.
		await pending.click();
		const invitation = teammatePage.getByRole("dialog", { name: "Invitation" });
		await invitation.getByRole("group", { name: "Your answer" }).getByRole("button", { name: "Yes" }).click();
		await expect(teammatePage.getByRole("button", { name: `${title}, 10:00 AM – 11:00 AM` })).toHaveCount(1);
		// The answer reaches the calendar of the organizer through the outbox, and then the page of the organizer
		// updates without a reload. An open dialog keeps the event of its open, so open it again until it shows.
		const edit = organizerPage.getByRole("dialog", { name: "Edit event" });
		await expect(async () => {
			await organizerPage.getByRole("button", { name: `${title}, 10:00 AM – 11:00 AM` }).click();
			try {
				await expect(edit.getByRole("list", { name: "Attendees" }).getByText("Yes", { exact: true })).toBeVisible({
					timeout: 1000,
				});
			} finally {
				await edit.getByRole("button", { name: "Cancel", exact: true }).click();
			}
		}).toPass({ timeout: 15_000 });

		// The second session loses its socket and its network. The organizer moves the meeting and renames it.
		await socket.cut();
		await second.setOffline(true);
		const moved = `${title} moved`;
		await api(organizer, "POST", `/api/v1/calendar/events/${event.id}`, {
			when: { kind: "timed", start: at(day, "13:00"), end: at(day, "14:00"), time_zone: "America/New_York" },
		});
		await api(organizer, "POST", `/api/v1/calendar/events/${event.id}`, { title: moved });
		await expect(teammatePage.getByRole("button", { name: `${moved}, 1:00 PM – 2:00 PM` })).toHaveCount(1);
		await expect(secondPage.getByRole("button", { name: `${title}, 10:00 AM – 11:00 AM` })).toHaveCount(1);

		// It connects again, and reads the changes after its cursor: exactly one meeting, at the new time.
		socket.restore();
		await second.setOffline(false);
		await expect(secondPage.getByRole("button", { name: `${moved}, 1:00 PM – 2:00 PM` })).toHaveCount(1, {
			timeout: 20_000,
		});
		await expect(secondPage.getByRole("button", { name: new RegExp(`${title}, 10:00 AM`) })).toHaveCount(0);

		// The organizer cancels. Each page removes the meeting without a reload.
		await api(organizer, "DELETE", `/api/v1/calendar/events/${event.id}`);
		for (const page of [organizerPage, secondPage, teammatePage]) {
			await expect(page.getByRole("button", { name: new RegExp(title) })).toHaveCount(0);
		}
	} finally {
		await organizer.close();
		await second.close();
		await teammate.close();
	}
});
