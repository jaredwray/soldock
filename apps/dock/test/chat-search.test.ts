import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { InputOf } from "@asterra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor, api, base64, callTool, codeOf, seedOrg } from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

const createRoom = async (actor: Actor, kind: "public" | "private", name: string, member_ids: string[] = []) =>
	(await actor.call("chat.create_room", { kind, name, member_ids })).room;

const post = async (actor: Actor, room_id: string, text: string, parent_id?: string) =>
	(await actor.call("chat.post_message", { room_id, text, ...(parent_id ? { parent_id } : {}) })).message;

type Search = Omit<InputOf<"chat.search_messages">, "query">;

/** The texts of the messages that a search finds, in the order of the results. */
const find = async (actor: Actor, query: string, input: Search = {}) =>
	(await actor.call("chat.search_messages", { query, ...input })).results.map((result) => result.message.text);

function roomStub(roomId: string) {
	return env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId));
}

/**
 * Waits until a room sent each change to the index of the organization. A room sends a change after a
 * short time, with its alarm.
 */
async function indexed(...roomIds: string[]): Promise<void> {
	for (const roomId of roomIds) {
		const stub = roomStub(roomId);
		await vi.waitFor(
			async () => {
				await runDurableObjectAlarm(stub);
				const waiting = await runInDurableObject(
					stub,
					(_instance, state) =>
						state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE target LIKE 'search:%'").one()
							.n,
				);
				if (waiting > 0) throw new Error(`${waiting} messages wait for the index`);
			},
			{ timeout: 5000, interval: 25 },
		);
	}
}

describe("search in one room", () => {
	// Acceptance of issue 75: a member finds a message of a private room, and a different principal does not.
	it("finds the messages and the replies of a private room for a person and an agent that are members, and for nobody else", async () => {
		const room = await createRoom(ada, "private", "Finance", [bot.id]);
		const first = await post(ada, room.id, "The budget for the launch is ready.");
		await post(bot, room.id, "I read it.");
		const reply = await post(bot, room.id, "One budget line is wrong.", first.id);

		// A person, through REST. The newest message comes first, and a reply is a result too.
		const found = await ada.call("chat.search_messages", { room_id: room.id, query: "budget", sort: "time" });
		expect(found.results.map((result) => [result.message.id, result.message.parent_id, result.parent_seq])).toEqual([
			[reply.id, first.id, first.seq],
			[first.id, null, null],
		]);
		expect(found.results[0]?.room).toEqual({ id: room.id, kind: "private", name: "Finance", peer: null });
		// The highlights are the places of the found word in the text.
		for (const { message, highlights } of found.results) {
			expect(highlights.map(({ start, end }) => message.text.slice(start, end))).toEqual(["budget"]);
		}

		// An agent, through MCP.
		const tool = await callTool(bot.key, "chat_search_messages", { room_id: room.id, query: "budget", sort: "time" });
		expect(tool.isError).toBeFalsy();
		const results = tool.structuredContent?.results as { message: { id: string } }[];
		expect(results.map((result) => result.message.id)).toEqual([reply.id, first.id]);

		// A key without the scope of a read of Chat cannot search, also for a member.
		const { api_key: writeOnly } = await ada.call("account.create_api_key", {
			label: "Poster",
			scopes: ["chat.write"],
		});
		const narrow = api(writeOnly.secret);
		expect(await codeOf(narrow("chat.search_messages", { room_id: room.id, query: "budget" }))).toBe("forbidden");
		expect(await codeOf(narrow("chat.search_messages", { query: "budget" }))).toBe("forbidden");

		// The owner of the organization is not a member: the room does not exist for it.
		expect(await codeOf(owner.call("chat.search_messages", { room_id: room.id, query: "budget" }))).toBe("not_found");
		const refused = await callTool(owner.key, "chat_search_messages", { room_id: room.id, query: "budget" });
		expect(refused.isError).toBe(true);
	});

	it("refuses a principal that did not join a public room", async () => {
		const room = await createRoom(ada, "public", "Launch");
		await post(ada, room.id, "The budget is ready.");
		expect(await codeOf(bot.call("chat.search_messages", { room_id: room.id, query: "budget" }))).toBe("forbidden");
		await bot.call("chat.join_room", { room_id: room.id });
		expect(await find(bot, "budget", { room_id: room.id })).toEqual(["The budget is ready."]);
	});

	// The write of a message and the write of its search rows are one step, so the room is never behind.
	it("finds the new text of an edited message at once, and never a deleted message", async () => {
		const room = await createRoom(ada, "private", "Finance");
		const message = await post(ada, room.id, "We meet on Monday.");
		await ada.call("chat.edit_message", { room_id: room.id, message_id: message.id, text: "We meet on Tuesday." });
		expect(await find(ada, "monday", { room_id: room.id })).toEqual([]);
		expect(await find(ada, "tuesday", { room_id: room.id })).toEqual(["We meet on Tuesday."]);
		await ada.call("chat.delete_message", { room_id: room.id, message_id: message.id });
		expect(await find(ada, "tuesday", { room_id: room.id })).toEqual([]);
		expect(await find(ada, "from:me", { room_id: room.id })).toEqual([]);
	});

	it("needs each word, and reads a phrase, the start of a word, the letter case and the accents", async () => {
		const room = await createRoom(ada, "private", "Notes");
		for (const text of [
			"Release plan for the café",
			"The plan of the release",
			"Deployment starts",
			"We deploy on Friday",
		]) {
			await post(ada, room.id, text);
		}
		const inRoom = { room_id: room.id, sort: "time" } as const;
		expect(await find(ada, "PLAN release", inRoom)).toEqual(["The plan of the release", "Release plan for the café"]);
		expect(await find(ada, '"release plan"', inRoom)).toEqual(["Release plan for the café"]);
		expect(await find(ada, "cafe", inRoom)).toEqual(["Release plan for the café"]);
		expect(await find(ada, "deploy", inRoom)).toEqual(["We deploy on Friday"]);
		expect(await find(ada, "deploy*", inRoom)).toEqual(["We deploy on Friday", "Deployment starts"]);
		// The operators of the search table have no effect: they are words.
		expect(await find(ada, "plan NOT release", inRoom)).toEqual([]);
		expect(await find(ada, 'plan OR "', inRoom)).toEqual([]);
	});

	it("filters by the author, a link, a file, a thread, a mention and the date", async () => {
		const room = await createRoom(ada, "private", "Launch", [bot.id]);
		const plan = await post(ada, room.id, "The plan is at https://example.com/plan");
		await post(bot, room.id, "Thanks for the plan", plan.id);
		await ada.call("chat.post_message", { room_id: room.id, markdown: "A [plan](https://example.com/b) for @bot" });
		const file = (await ada.call("drive.upload_file", { name: "plan.txt", content_base64: base64("x") })).item;
		await ada.call("chat.post_message", { room_id: room.id, text: "The plan as a file", file_ids: [file.id] });
		await post(bot, room.id, "No plan from me");
		const search = (query: string) => find(ada, query, { room_id: room.id, sort: "time" });

		expect(await search("plan from:bot")).toEqual(["No plan from me", "Thanks for the plan"]);
		expect(await search(`from:${bot.id} from:me is:thread`)).toEqual([
			"Thanks for the plan",
			"The plan is at https://example.com/plan",
		]);
		expect(await search("has:link")).toEqual(["A plan for @bot", "The plan is at https://example.com/plan"]);
		expect(await search("has:file")).toEqual(["The plan as a file"]);
		expect(await search("mentions:@bot")).toEqual(["A plan for @bot"]);
		// For the agent, `me` is the agent.
		expect(await find(bot, "mentions:me", { room_id: room.id })).toEqual(["A plan for @bot"]);
		expect(await find(bot, "from:me plan", { room_id: room.id, sort: "time" })).toEqual([
			"No plan from me",
			"Thanks for the plan",
		]);

		// A date is a day in UTC. `after` has that day, and `before` does not.
		const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
		expect(await search(`plan after:${day(0)} before:${day(1)}`)).toHaveLength(5);
		expect(await search(`plan on:${day(0)}`)).toHaveLength(5);
		expect(await search(`plan before:${day(0)}`)).toEqual([]);
		expect(await search(`plan after:${day(1)}`)).toEqual([]);
	});

	it("gives the best match first by rank and the newest first by time, in pages", async () => {
		const room = await createRoom(ada, "private", "Notes");
		await post(ada, room.id, "plan plan plan");
		await post(ada, room.id, "One plan in a long line of many other words that are not the word of the query");
		await post(ada, room.id, "plan and plan");
		const texts = (results: { message: { text: string } }[]) => results.map((result) => result.message.text);

		// The rank is the default for a query with words.
		const ranked = await ada.call("chat.search_messages", { room_id: room.id, query: "plan", limit: 2 });
		expect(texts(ranked.results)).toEqual(["plan plan plan", "plan and plan"]);
		const rankedRest = await ada.call("chat.search_messages", {
			room_id: room.id,
			query: "plan",
			limit: 2,
			cursor: ranked.next_cursor ?? "",
		});
		expect(texts(rankedRest.results)).toHaveLength(1);
		expect(rankedRest.next_cursor).toBeNull();

		const newest = await ada.call("chat.search_messages", { room_id: room.id, query: "plan", sort: "time", limit: 2 });
		expect(texts(newest.results)).toEqual(["plan and plan", texts(rankedRest.results)[0]]);
		const older = await ada.call("chat.search_messages", {
			room_id: room.id,
			query: "plan",
			sort: "time",
			limit: 2,
			cursor: newest.next_cursor ?? "",
		});
		expect(texts(older.results)).toEqual(["plan plan plan"]);
		expect(older.next_cursor).toBeNull();
		// The result tells the order that the search used.
		expect([ranked.sort, newest.sort]).toEqual(["rank", "time"]);
		const filtersOnly = await ada.call("chat.search_messages", { room_id: room.id, query: "from:me", sort: "rank" });
		expect(filtersOnly.sort).toBe("time");
		// A query with filters only has no rank: the newest message comes first.
		expect(await find(ada, "from:me", { room_id: room.id, limit: 1 })).toEqual(["plan and plan"]);
		// A cursor of the one order is no cursor of the other.
		const mixed = { room_id: room.id, query: "plan", sort: "time", cursor: ranked.next_cursor ?? "" } as const;
		expect(await codeOf(ada.call("chat.search_messages", mixed))).toBe("invalid");
	});

	// A cursor near the end of a read by rank can come with a larger page. The read still ends at the limit.
	it("ends a read by rank at 1,000 results, also for a larger page after a cursor near the end", async () => {
		const room = await createRoom(ada, "private", "Notes");
		const first = await post(ada, room.id, "plan");
		// The rate limit permits no 1,000 posts in a test, so the room gets the rows of 1,010 more messages.
		await runInDurableObject(roomStub(room.id), (_instance, state) => {
			const sql = state.storage.sql;
			const author = sql.exec<{ author_json: string }>("SELECT author_json FROM messages WHERE seq = 1").one();
			for (let n = 2; n <= 1011; n++) {
				sql.exec(
					"INSERT INTO messages (seq, id, author_id, author_json, text, created_at, version) VALUES (?, ?, ?, ?, 'plan', ?, ?)",
					n,
					`cmsg_01JD${String(n).padStart(22, "0")}`,
					ada.id,
					author.author_json,
					Date.parse(first.created_at) + n,
					n,
				);
				sql.exec("INSERT INTO messages_fts (rowid, text) VALUES (?, 'plan')", n);
			}
		});
		const cursor = btoa(JSON.stringify(["r", 990]));
		const last = await ada.call("chat.search_messages", { room_id: room.id, query: "plan", limit: 50, cursor });
		expect([last.results.length, last.next_cursor]).toEqual([10, null]);
	});

	it("refuses a query that it cannot read, and tells why", async () => {
		const room = await createRoom(ada, "private", "Notes");
		const search = (query: string) => ada.call("chat.search_messages", { room_id: room.id, query });
		for (const query of [
			"has:picture",
			"is:starred",
			"before:tomorrow",
			"on:2026-02-30",
			"from:nobody",
			"!!!",
			"in:Notes x",
			"de*",
			'"release pl"*',
		]) {
			expect(await codeOf(search(query)), query).toBe("invalid");
		}
		await expect(search("from:nobody")).rejects.toThrow("@nobody");
		// A key with only the read scope of Chat cannot read the directory. For it, a handle of no principal
		// finds nothing, so the answer does not tell which addresses the organization has.
		await post(ada, room.id, "A memo of ada");
		const { api_key: chatOnly } = await ada.call("account.create_api_key", { label: "Reader", scopes: ["chat.read"] });
		const reader = api(chatOnly.secret);
		for (const input of [{ room_id: room.id }, {}]) {
			expect((await reader("chat.search_messages", { ...input, query: "memo from:nobody" })).results).toEqual([]);
			expect((await reader("chat.search_messages", { ...input, query: "memo mentions:nobody" })).results).toEqual([]);
		}
		expect((await reader("chat.search_messages", { room_id: room.id, query: "memo from:ada" })).results).toHaveLength(
			1,
		);
		expect(await codeOf(ada.call("chat.search_messages", { room_id: room.id, query: "x", cursor: "?" }))).toBe(
			"invalid",
		);
		// A cursor that a client made, with an offset that is no place in the results.
		for (const offset of [-1, 1.5, 1_000_000]) {
			const cursor = btoa(JSON.stringify(["r", offset]));
			expect(await codeOf(ada.call("chat.search_messages", { room_id: room.id, query: "x", cursor }))).toBe("invalid");
			expect(await codeOf(ada.call("chat.search_messages", { query: "x", cursor }))).toBe("invalid");
		}
		// A word with a colon that is no filter is a word.
		await post(ada, room.id, "See note: the plan");
		expect(await find(ada, "note:", { room_id: room.id })).toEqual(["See note: the plan"]);
	});
});

describe("search across rooms", () => {
	// Acceptance of issue 75, for REST and MCP, and for a person and an agent.
	it("finds the messages of each room of the caller, and no message of a room that the caller is not in", async () => {
		const finance = await createRoom(ada, "private", "Finance", [bot.id]);
		const launch = await createRoom(ada, "public", "Launch");
		const dm = (await ada.call("chat.open_dm", { principal_id: owner.id })).room;
		const secret = await post(ada, finance.id, "The budget is a secret.");
		const open = await post(ada, launch.id, "The budget of the launch.");
		const direct = await post(ada, dm.id, "Your budget, in private.");
		await indexed(finance.id, launch.id, dm.id);

		const found = await ada.call("chat.search_messages", { query: "budget", sort: "time" });
		expect(found.results.map((result) => [result.room.id, result.message.id])).toEqual([
			[dm.id, direct.id],
			[launch.id, open.id],
			[finance.id, secret.id],
		]);
		expect(found.results[0]?.room).toMatchObject({ kind: "dm", name: null, peer: { principal_id: owner.id } });
		expect(found.results[0]?.highlights.map(({ start, end }) => direct.text.slice(start, end))).toEqual(["budget"]);

		// The agent is a member of the private room only. It searches through MCP.
		const tool = await callTool(bot.key, "chat_search_messages", { query: "budget" });
		const results = tool.structuredContent?.results as { message: { id: string } }[];
		expect(results.map((result) => result.message.id)).toEqual([secret.id]);
		// The owner of the organization has the direct message only: its role gives no access to a room.
		expect(await find(owner, "budget")).toEqual(["Your budget, in private."]);
		// A public room that the caller did not join is not searched.
		await owner.call("chat.join_room", { room_id: launch.id });
		expect(await find(owner, "budget", { sort: "time" })).toEqual([
			"Your budget, in private.",
			"The budget of the launch.",
		]);
	});

	// Acceptance: the room returns each message, so the index can be behind and a deleted message never shows.
	it("does not show a deleted message before the index gets the delete, and follows an edit", async () => {
		const room = await createRoom(ada, "private", "Finance");
		const gone = await post(ada, room.id, "The first budget.");
		const edited = await post(ada, room.id, "The second budget.");
		await indexed(room.id);
		expect(await find(ada, "budget")).toHaveLength(2);

		await ada.call("chat.delete_message", { room_id: room.id, message_id: gone.id });
		await ada.call("chat.edit_message", { room_id: room.id, message_id: edited.id, text: "The second forecast." });
		// The index still has the two old texts. The room does not return them.
		expect(await find(ada, "budget")).toEqual([]);
		await indexed(room.id);
		expect(await find(ada, "budget")).toEqual([]);
		expect(await find(ada, "forecast")).toEqual(["The second forecast."]);
	});

	// Acceptance: a member that leaves a room gets no hit from that room.
	it("gives a member that left a room no hit from that room", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		await post(ada, room.id, "The budget of the launch.");
		await indexed(room.id);
		expect(await find(bot, "budget")).toHaveLength(1);
		await bot.call("chat.remove_member", { room_id: room.id, principal_id: bot.id });
		expect(await find(bot, "budget")).toEqual([]);
		// The owner removes a member: the same.
		await ada.call("chat.add_members", { room_id: room.id, principal_ids: [owner.id] });
		expect(await find(owner, "budget")).toHaveLength(1);
		await ada.call("chat.remove_member", { room_id: room.id, principal_id: owner.id });
		expect(await find(owner, "budget")).toEqual([]);
	});

	// The list of the caller in its PrincipalDO can be behind a removal. The room makes the check again.
	it("gives no hit from a room when the list of the caller still has the room after a removal", async () => {
		const room = await createRoom(ada, "private", "Finance", [bot.id]);
		await post(ada, room.id, "The budget is a secret.");
		await post(ada, room.id, "The budget has two lines.");
		await indexed(room.id);
		expect(await find(bot, "budget")).toHaveLength(2);
		// The room removes the member, as a removal whose state did not reach the object of the member yet.
		await runInDurableObject(roomStub(room.id), (_instance, state) => {
			state.storage.sql.exec("DELETE FROM members WHERE principal_id = ?", bot.id);
		});
		expect((await bot.call("chat.list_rooms")).rooms.map((listed) => listed.id)).toEqual([room.id]);
		expect(await find(bot, "budget")).toEqual([]);
		// The index has more hits than one page. No cursor tells that the room has them.
		const page = await bot.call("chat.search_messages", { query: "budget", sort: "time", limit: 1 });
		expect(page).toMatchObject({ results: [], next_cursor: null });
	});

	it("filters by the room, the author, a mention, a thread, a link, a file and the date", async () => {
		const launch = await createRoom(ada, "public", "Launch Plans", [bot.id]);
		const finance = await createRoom(ada, "private", "Finance", [bot.id]);
		const dm = (await ada.call("chat.open_dm", { principal_id: bot.id })).room;
		const plan = await post(ada, launch.id, "plan one https://example.com/a");
		await post(bot, launch.id, "plan two", plan.id);
		await post(bot, finance.id, "plan three for @ada");
		const file = (await ada.call("drive.upload_file", { name: "plan.txt", content_base64: base64("x") })).item;
		await ada.call("chat.post_message", { room_id: dm.id, text: "plan four", file_ids: [file.id] });
		await indexed(launch.id, finance.id, dm.id);
		const search = (query: string) => find(ada, query, { sort: "time" });

		expect(await search("plan")).toEqual([
			"plan four",
			"plan three for @ada",
			"plan two",
			"plan one https://example.com/a",
		]);
		expect(await search('plan in:"launch plans"')).toEqual(["plan two", "plan one https://example.com/a"]);
		expect(await search(`plan in:#finance in:${dm.id}`)).toEqual(["plan four", "plan three for @ada"]);
		expect(await search("in:@bot")).toEqual(["plan four"]);
		expect(await search("plan from:bot")).toEqual(["plan three for @ada", "plan two"]);
		expect(await search("mentions:me")).toEqual(["plan three for @ada"]);
		expect(await search("is:thread")).toEqual(["plan two", "plan one https://example.com/a"]);
		expect(await search("has:link")).toEqual(["plan one https://example.com/a"]);
		expect(await search("has:file")).toEqual(["plan four"]);
		const today = new Date().toISOString().slice(0, 10);
		expect(await search(`plan on:${today}`)).toHaveLength(4);
		expect(await search(`plan before:${today}`)).toEqual([]);

		// A room that the caller is not in is no room for `in:`, also when it exists.
		await createRoom(owner, "private", "Board");
		expect(await codeOf(ada.call("chat.search_messages", { query: "plan in:board" }))).toBe("invalid");
		expect(await codeOf(ada.call("chat.search_messages", { query: "plan in:@owner" }))).toBe("invalid");
	});

	// A reaction changes a message, and it changes nothing that a search reads. So it sends nothing to the index.
	it("sends a message to the index for a post, an edit and a delete, and not for a reaction", async () => {
		const room = await createRoom(ada, "private", "Finance");
		const message = await post(ada, room.id, "The budget.");
		await indexed(room.id);
		const waiting = () =>
			runInDurableObject(
				roomStub(room.id),
				(_instance, state) =>
					state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE target LIKE 'search:%'").one()
						.n,
			);
		await ada.call("chat.add_reaction", { room_id: room.id, message_id: message.id, emoji: "👍" });
		expect(await waiting()).toBe(0);
		await ada.call("chat.edit_message", { room_id: room.id, message_id: message.id, text: "The forecast." });
		expect(await waiting()).toBe(1);
	});

	it("gives the pages of the two orders across rooms", async () => {
		const one = await createRoom(ada, "private", "One");
		const two = await createRoom(ada, "private", "Two");
		await post(ada, one.id, "plan and one more plan and a plan");
		await post(ada, two.id, "a plan in a line with a number of other words that are not in the query");
		await post(ada, one.id, "plan plan");
		await indexed(one.id, two.id);
		const page = async (input: Search) => {
			const found = await ada.call("chat.search_messages", { query: "plan", limit: 2, ...input });
			return { texts: found.results.map((result) => result.message.text), next: found.next_cursor ?? "" };
		};
		const newest = await page({ sort: "time" });
		expect(newest.texts).toEqual([
			"plan plan",
			"a plan in a line with a number of other words that are not in the query",
		]);
		const oldest = await page({ sort: "time", cursor: newest.next });
		expect([oldest.texts, oldest.next]).toEqual([["plan and one more plan and a plan"], ""]);

		const best = await page({});
		const rest = await page({ cursor: best.next });
		expect([...best.texts, ...rest.texts].at(-1)).toBe(newest.texts[1]);
		expect([best.texts.length, rest.texts.length, rest.next]).toEqual([2, 1, ""]);
		expect(await codeOf(ada.call("chat.search_messages", { query: "plan", cursor: newest.next }))).toBe("invalid");
	});
});

describe("the order of the rank across rooms", () => {
	// The word counts of one index have the words of each room. A rank from them told a principal that
	// is not a member which words a private room has: it wrote two messages, and their order changed
	// when a guess of the next word was correct.
	it("does not change with the words of a room that the caller is not in", async () => {
		const board = await createRoom(ada, "private", "Board");
		await post(ada, board.id, "The deploy password is hunter2, keep it quiet.");
		await indexed(board.id);
		const probe = await createRoom(bot, "private", "Probe");
		/** True when the message with the phrase two times comes before the message with the marker two times. */
		const phraseFirst = async (guess: string, marker: string) => {
			const markers = await post(bot, probe.id, `password is ${guess} ${marker} ${marker} pad pad`);
			const phrases = await post(bot, probe.id, `password is ${guess} password is ${guess} ${marker}`);
			await indexed(probe.id);
			const found = await bot.call("chat.search_messages", { query: `"password is ${guess}"* ${marker}` });
			const ids = found.results.map((result) => result.message.id);
			expect([...ids].sort()).toEqual([markers.id, phrases.id].sort());
			return ids[0] === phrases.id;
		};
		// "hun" is the start of the word in the room of ada, and "abc" is not. The order is the same.
		expect(await phraseFirst("hun", "zzmarkerone")).toBe(await phraseFirst("abc", "zzmarkertwo"));
	});

	it("puts the best match of each room first, from the words of that room", async () => {
		const one = await createRoom(ada, "private", "One");
		const two = await createRoom(ada, "private", "Two");
		await post(ada, one.id, "A plan is in this long line with many other words that are not in the query at all");
		await post(ada, one.id, "plan plan plan");
		await post(ada, two.id, "No word of the query");
		await post(ada, two.id, "A plan");
		await indexed(one.id, two.id);
		const found = await ada.call("chat.search_messages", { query: "plan" });
		expect(found.sort).toBe("rank");
		const texts = found.results.map((result) => result.message.text);
		expect(texts).toHaveLength(3);
		expect(texts.indexOf("plan plan plan")).toBeLessThan(
			texts.indexOf(texts.find((text) => text.startsWith("A plan is")) ?? ""),
		);
	});
});

describe("the search index of the organization", () => {
	const index = () => env.CHAT_SEARCH.get(env.CHAT_SEARCH.idFromName("org:0"));

	// A room sends the state of a message, with a stamp that grows. A batch that comes two times, or late, changes nothing.
	it("applies each batch of a room one time, and ignores an older batch that comes late", async () => {
		const room = await createRoom(ada, "private", "Finance");
		await post(ada, room.id, "The budget.");
		await indexed(room.id);
		const hits = async () =>
			(
				await index().search({
					rooms: [room.id],
					filter: {
						match: '"budget"',
						from: [],
						mentions: [],
						hasLink: false,
						hasFile: false,
						isThread: false,
						before: null,
						after: null,
					},
					after: null,
					limit: 10,
				})
			).hits.map((hit) => hit.seq);
		expect(await hits()).toEqual([1]);
		// A batch from before the newest batch of the room: the delete in it does not apply.
		await index().apply({ roomId: room.id, stamp: 0, entries: [{ seq: 1, row: null }], filled: false });
		expect(await hits()).toEqual([1]);
	});

	// chat.delete_message deletes the text. The search tables must not keep its words in their storage.
	it("keeps no word of a deleted message and of the text before an edit, in the room and in the index", async () => {
		const room = await createRoom(ada, "private", "Finance");
		const gone = await post(ada, room.id, "The zebraquagga budget.");
		const edited = await post(ada, room.id, "The okapigiraffe budget.");
		await post(ada, room.id, "A message that stays.");
		await indexed(room.id);
		/** The bytes of the word index of FTS5, as text. A word is in them as it is. */
		const words = (stub: DurableObjectStub) =>
			runInDurableObject(stub, (_instance, state) =>
				state.storage.sql
					.exec<{ block: ArrayBuffer }>("SELECT block FROM messages_fts_data")
					.toArray()
					.map((row) => new TextDecoder("latin1").decode(new Uint8Array(row.block)))
					.join(" "),
			);
		for (const stub of [roomStub(room.id), index()]) {
			const stored = await words(stub);
			expect(stored).toContain("zebraquagga");
			expect(stored).toContain("okapigiraffe");
		}
		await ada.call("chat.delete_message", { room_id: room.id, message_id: gone.id });
		await ada.call("chat.edit_message", { room_id: room.id, message_id: edited.id, text: "The new budget." });
		await indexed(room.id);
		for (const [name, stub] of [
			["room", roomStub(room.id)],
			["index", index()],
		] as const) {
			const stored = await words(stub);
			expect(stored.includes("zebraquagga"), name).toBe(false);
			expect(stored.includes("okapigiraffe"), name).toBe(false);
			expect(stored.includes("stays"), name).toBe(true);
			// The table of the text has no row with the old text. The index has the rows of each room.
			const texts = await runInDurableObject(stub, (_instance, state) =>
				state.storage.sql
					.exec<{ text: string }>(
						name === "room"
							? "SELECT text FROM messages_fts"
							: "SELECT f.text FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE m.room_id = ?",
						...(name === "room" ? [] : [room.id]),
					)
					.toArray()
					.map((row) => row.text),
			);
			expect(texts.sort(), name).toEqual(["A message that stays.", "The new budget."]);
		}
	});

	// The index is a copy. The rooms must be able to build it again, also a room that is in use at that time.
	it("gets each message of a room again after it lost its rows, with the next batch of the room", async () => {
		const room = await createRoom(ada, "private", "Finance");
		await post(ada, room.id, "The first budget.");
		await post(ada, room.id, "The second budget.");
		await indexed(room.id);
		await runInDurableObject(index(), (_instance, state) => {
			for (const table of ["rooms", "messages", "messages_fts", "mentions"])
				state.storage.sql.exec(`DELETE FROM ${table}`);
		});
		// A new message is the next batch. The index tells the room that it has no row of it.
		await post(ada, room.id, "No word of the query.");
		await indexed(room.id);
		expect(await find(ada, "budget", { sort: "time" })).toEqual(["The second budget.", "The first budget."]);
	});

	// One index serves each room. A change of a message must not wait for it, also while it is slow.
	it("does not make a post wait while the index does not answer", async () => {
		const room = await createRoom(ada, "private", "Finance");
		// Plain flags, not promises: a promise from the test cannot continue a call inside the object.
		const gate = { entered: false, released: false };
		await runInDurableObject(roomStub(room.id), (instance) => {
			const target = instance as unknown as { env: Env };
			const real = target.env.CHAT_SEARCH;
			const slow = {
				idFromName: (name: string) => real.idFromName(name),
				get: (id: DurableObjectId) => ({
					apply: async (batch: Parameters<ReturnType<typeof real.get>["apply"]>[0]) => {
						gate.entered = true;
						while (!gate.released) await scheduler.wait(5);
						return real.get(id).apply(batch);
					},
				}),
			};
			target.env = { ...target.env, CHAT_SEARCH: slow as unknown as Env["CHAT_SEARCH"] };
		});
		await post(ada, room.id, "The first budget.");
		// The alarm sends the message to the index, which does not answer.
		const alarm = vi.waitFor(
			async () => {
				await runDurableObjectAlarm(roomStub(room.id));
				expect(gate.entered).toBe(true);
			},
			{ timeout: 5000, interval: 25 },
		);
		await vi.waitFor(() => expect(gate.entered).toBe(true), { timeout: 5000, interval: 10 });
		// A post, an edit and a search in the room answer during that time.
		const second = await post(ada, room.id, "The second budget.");
		await ada.call("chat.edit_message", { room_id: room.id, message_id: second.id, text: "The second forecast." });
		expect(await find(ada, "budget", { room_id: room.id })).toEqual(["The first budget."]);
		expect(gate.released).toBe(false);
		gate.released = true;
		await alarm;
		await indexed(room.id);
		expect(await find(ada, "forecast")).toEqual(["The second forecast."]);
	});

	// The answer of the index to the first batch can get lost. The fill must not depend on that one answer.
	it("gets each message of a room again also when the answer to the first batch after the loss got lost", async () => {
		const room = await createRoom(ada, "private", "Finance");
		await post(ada, room.id, "The first budget.");
		await post(ada, room.id, "The second budget.");
		await indexed(room.id);
		await runInDurableObject(index(), (_instance, state) => {
			for (const table of ["rooms", "messages", "messages_fts", "mentions"])
				state.storage.sql.exec(`DELETE FROM ${table}`);
		});
		// The index applies the next batch of the room, and the room gets an error in place of the answer.
		const lost = { calls: 0 };
		await runInDurableObject(roomStub(room.id), (instance) => {
			const target = instance as unknown as { env: Env };
			const real = target.env.CHAT_SEARCH;
			const lossy = {
				idFromName: (name: string) => real.idFromName(name),
				get: (id: DurableObjectId) => ({
					apply: async (batch: Parameters<ReturnType<typeof real.get>["apply"]>[0]) => {
						const answer = await real.get(id).apply(batch);
						lost.calls += 1;
						if (lost.calls === 1) throw new Error("The answer got lost.");
						return answer;
					},
				}),
			};
			target.env = { ...target.env, CHAT_SEARCH: lossy as unknown as Env["CHAT_SEARCH"] };
		});
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			await post(ada, room.id, "No word of the query.");
			// The room tries the send again after one minute.
			vi.setSystemTime(Date.now() + 1000);
			await runDurableObjectAlarm(roomStub(room.id));
			expect(lost.calls).toBe(1);
			vi.setSystemTime(Date.now() + 61_000);
			await indexed(room.id);
		} finally {
			vi.useRealTimers();
		}
		expect(await find(ada, "budget", { sort: "time" })).toEqual(["The second budget.", "The first budget."]);
	});

	// A room from before search has its messages in its own tables only, until it starts again.
	it("gets the messages of a room from before the index, when a search finds that the index does not know the room", async () => {
		const room = await createRoom(ada, "private", "Old room", [bot.id]);
		const plan = await post(ada, room.id, "The old plan for @bot at https://example.com/old");
		await post(bot, room.id, "An old reply", plan.id);
		const gone = await post(ada, room.id, "An old mistake");
		await ada.call("chat.delete_message", { room_id: room.id, message_id: gone.id });
		await indexed(room.id);
		// The room goes back to the schema before search, and the index forgets the room.
		await runInDurableObject(roomStub(room.id), (_instance, state) => {
			const sql = state.storage.sql;
			sql.exec("DROP TABLE messages_fts");
			sql.exec("DROP TABLE search_mentions");
			sql.exec("ALTER TABLE messages DROP COLUMN has_link");
			sql.exec("DELETE FROM outbox WHERE target LIKE 'search:%'");
			sql.exec("UPDATE meta SET value = CAST(CAST(value AS INTEGER) - 1 AS TEXT) WHERE key = 'schema_version'");
		});
		await runInDurableObject(index(), (_instance, state) => {
			for (const table of ["rooms", "messages", "messages_fts", "mentions"])
				state.storage.sql.exec(`DELETE FROM ${table}`);
		});
		await expect(runInDurableObject(roomStub(room.id), (_instance, state) => state.abort())).rejects.toThrow();

		// The first search across the rooms asks the room, which sends its messages.
		expect(await find(bot, "old", { sort: "time" })).toEqual([
			"An old reply",
			"The old plan for @bot at https://example.com/old",
		]);
		expect(await find(bot, "mentions:me has:link is:thread")).toEqual([
			"The old plan for @bot at https://example.com/old",
		]);
		expect(await find(bot, "mistake")).toEqual([]);
		// The search tables of the room have the old messages too.
		expect(await find(ada, "mentions:bot has:link", { room_id: room.id })).toEqual([
			"The old plan for @bot at https://example.com/old",
		]);
	});
});
