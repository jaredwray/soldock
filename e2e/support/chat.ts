import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { BASE_URL } from "./server.ts";

// The people of the seed data (`tools/seed/src/cast.ts`). The password is the first part of the
// address and " local password".
export type Person = "nadia" | "tomasz" | "chidi" | "meiling" | "rafael" | "ingrid";

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };

/** A browser context with the session of a person of the seed data. */
export async function signIn(browser: Browser, person: Person): Promise<BrowserContext> {
	const context = await browser.newContext();
	const response = await context.request.post("/auth/session", {
		headers: JSON_HEADERS,
		data: { address: `${person}@example.com`, password: `${person} local password` },
	});
	expect(response.status(), `sign-in of ${person}`).toBe(200);
	return context;
}

/** A name that no other test uses. */
export function unique(prefix: string): string {
	return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Calls the REST API with the session of the context. */
async function call<T>(
	request: APIRequestContext,
	method: "GET" | "POST" | "DELETE",
	path: string,
	data?: unknown,
): Promise<T> {
	const response = await request.fetch(path, { method, headers: JSON_HEADERS, data: data ?? undefined });
	expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

export interface Message {
	id: string;
	seq: number;
	text: string;
	deleted: boolean;
	idempotency_key: string | null;
	/** The ids of the principals that the body mentions. */
	mentions: string[];
	/** The groups that the body mentions ("here", "channel"). */
	group_mentions: string[];
}

/** A public room of `owner`, which each person of `members` joined. Returns the id of the room. */
export async function createRoom(owner: BrowserContext, name: string, members: BrowserContext[] = []): Promise<string> {
	const { room } = await call<{ room: { id: string } }>(owner.request, "POST", "/api/v1/chat/rooms", {
		kind: "public",
		name,
	});
	for (const member of members) await call(member.request, "POST", `/api/v1/chat/rooms/${room.id}/join`, {});
	return room.id;
}

/** Posts a message as Markdown. */
export async function postMarkdown(context: BrowserContext, roomId: string, markdown: string): Promise<Message> {
	return (
		await call<{ message: Message }>(context.request, "POST", `/api/v1/chat/rooms/${roomId}/messages`, { markdown })
	).message;
}

export async function post(context: BrowserContext, roomId: string, text: string): Promise<Message> {
	return (await call<{ message: Message }>(context.request, "POST", `/api/v1/chat/rooms/${roomId}/messages`, { text }))
		.message;
}

/** Posts a reply in the thread of a message, as the person of the context. */
export async function reply(context: BrowserContext, roomId: string, parentId: string, text: string): Promise<Message> {
	return (
		await call<{ message: Message }>(context.request, "POST", `/api/v1/chat/rooms/${roomId}/messages`, {
			text,
			parent_id: parentId,
		})
	).message;
}

/** Adds a reaction of the person of the context to a message. */
export async function react(context: BrowserContext, roomId: string, messageId: string, emoji: string): Promise<void> {
	await call(context.request, "POST", `/api/v1/chat/rooms/${roomId}/messages/${messageId}/reactions`, { emoji });
}

/** Sets the read marker of the person of the context to the newest message of a room. */
export async function markRead(context: BrowserContext, roomId: string): Promise<void> {
	await call(context.request, "POST", `/api/v1/chat/rooms/${roomId}/read`, {});
}

/** Posts `count` messages "m1" to "m<count>", from the people in turn, inside the rate limit of each. */
export async function fill(people: BrowserContext[], roomId: string, count: number): Promise<void> {
	for (let index = 0; index < count; index++) {
		await post(people[index % people.length] as BrowserContext, roomId, `m${index + 1}`);
	}
}

/** The newest messages of a room, as the server has them. */
export async function newest(context: BrowserContext, roomId: string): Promise<Message[]> {
	return (
		await call<{ messages: Message[] }>(context.request, "GET", `/api/v1/chat/rooms/${roomId}/messages?limit=100`)
	).messages;
}

/** The rows of the message list with the text `text`. */
export function rowsWithText(page: Page, text: string) {
	return page.locator(".chat-message .chat-text").filter({ hasText: new RegExp(`^${escapeRegExp(text)}$`) });
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Opens a room and waits for its list. The list of a room without messages has no height, so the test waits for the box of a new message. */
export async function openRoom(page: Page, roomId: string): Promise<void> {
	await page.goto(`/chat/${roomId}`);
	await expect(page.locator(".chat-scroll")).toBeVisible();
	await expect(page.locator(".chat-composer")).toBeVisible();
}

/** The box for a new message of a room with the name `name`. */
export function composer(page: Page, name: string) {
	return page.getByRole("textbox", { name: `Message to ${name}` });
}

/**
 * The texts of the messages that wait for the server, from the store of the browser (`outboxStore.ts`
 * of the web app). A record goes when its message settles, so an empty list means that the outbox is done.
 */
export function waitingRecords(page: Page): Promise<string[]> {
	return page.evaluate(
		() =>
			new Promise<string[]>((resolve) => {
				const open = indexedDB.open("soldock-chat");
				open.onerror = () => resolve([]);
				open.onsuccess = () => {
					const database = open.result;
					if (!database.objectStoreNames.contains("outbox")) {
						resolve([]);
						return;
					}
					const all = database.transaction("outbox").objectStore("outbox").getAll();
					all.onsuccess = () => resolve((all.result as { text: string }[]).map((record) => record.text));
					all.onerror = () => resolve([]);
				};
			}),
	);
}
