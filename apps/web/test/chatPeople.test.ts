import type { ChatBody, DirectoryEntry, InputOf, OutputOf } from "@asterra/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { textParts } from "../src/features/chat/mentions.ts";
import { bodyPeople, createPeople } from "../src/features/chat/people.ts";

function entry(name: string, change: Partial<DirectoryEntry> = {}): DirectoryEntry {
	return {
		id: `prn_${name}`,
		kind: "human",
		display_name: name,
		address: `${name}@example.com`,
		org_role: "member",
		sponsor_id: null,
		outbound_policy: null,
		created_at: "2026-01-01T00:00:00.000Z",
		archived_at: null,
		description: null,
		created_by: null,
		handle: name,
		...change,
	};
}

afterEach(() => vi.useRealTimers());

type Input = InputOf<"directory.get_principals">;
type Output = OutputOf<"directory.get_principals">;

const list = (text: string | undefined) => (text === undefined ? [] : text.split(","));

/** A server with these principals and these name aliases, and a list of its calls. */
function server(principals: DirectoryEntry[], aliases: Record<string, string> = {}) {
	const calls: Input[] = [];
	let failing = false;
	const answer = (input: Input): Output => {
		const mentions = list(input.handles).flatMap((handle) => {
			const person = principals.find((p) => p.handle === handle || p.id === aliases[handle]);
			return person ? [{ handle, principal_id: person.id }] : [];
		});
		const ids = [...list(input.ids), ...mentions.map((mention) => mention.principal_id)];
		return { principals: principals.filter((p) => ids.includes(p.id)), mentions };
	};
	return {
		calls,
		lookup: async (input: Input) => {
			calls.push(input);
			if (failing) throw new Error("offline");
			return answer(input);
		},
		fail: (value: boolean) => {
			failing = value;
		},
		/** Waits for the call of the asks until now, and for each call that follows it. */
		flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
	};
}

describe("the people of a page", () => {
	// A room list shows many messages in one render. Each message asks for its people, and the page must
	// send one call for them, not one call for each message and not a read of the directory.
	it("asks for the ids and handles of one render in one call, each one time, and never again after the answer", async () => {
		const ada = entry("ada", { display_name: "Ada Lovelace" });
		const bot = entry("bot", { kind: "agent" });
		const api = server([ada, bot], { adalovelace: ada.id });
		const people = createPeople(api.lookup);
		let changes = 0;
		people.subscribe(() => changes++);
		const before = people.directory();

		people.want({ ids: [ada.id, "prn_gone"], handles: ["Bot", "adalovelace"] });
		people.want({ ids: [ada.id, bot.id], handles: ["bot", "nobody", "here", "channel"] });
		expect(api.calls).toEqual([]);
		await api.flush();
		// A word of a group is never the handle of a principal, so the page does not ask for it.
		expect(api.calls).toEqual([{ ids: `${ada.id},prn_gone,${bot.id}`, handles: "bot,adalovelace,nobody" }]);
		expect(changes).toBe(1);

		const directory = people.directory();
		expect(directory).not.toBe(before);
		expect([...directory.byId.keys()]).toEqual([ada.id, bot.id]);
		expect(directory.handleOf.get(bot.id)).toBe("bot");
		// The text of a message finds a handle, a full address and a name alias from the answers. A handle of
		// nobody stays text.
		expect(
			textParts("@bot @adalovelace @ada@example.com @nobody", directory)
				.filter((part) => part.person)
				.map((part) => [part.text, part.person?.id]),
		).toEqual([
			["@bot", bot.id],
			["@adalovelace", ada.id],
			["@ada@example.com", ada.id],
		]);

		// The page has each answer, also the answer "no principal". It asks for none of them again.
		people.want({ ids: [ada.id, "prn_gone"], handles: ["nobody", "bot"] });
		await api.flush();
		expect(api.calls).toHaveLength(1);
		expect(people.directory()).toBe(directory);
	});

	// A room has 500 members at most. The server refuses a call with more than 100 ids or handles, or with
	// more than 4,000 characters of them, so a large room needs more calls, each bounded.
	it("sends at most 100 ids and 4,000 characters of handles in one call, and the others in the next calls", async () => {
		const api = server([]);
		const people = createPeople(api.lookup);
		const ids = Array.from({ length: 250 }, (_, index) => `prn_${index}`);
		// A handle longer than an address names nobody, so the page does not ask for it.
		const handles = [...Array.from({ length: 30 }, (_, index) => `${"h".repeat(196)}${index + 100}`), "h".repeat(255)];
		people.want({ ids, handles });
		await api.flush();
		expect(api.calls.map((call) => list(call.ids).length)).toEqual([100, 100, 50]);
		expect(api.calls.flatMap((call) => list(call.ids))).toEqual(ids);
		// 20 handles of 199 characters and their commas are 4,000 characters.
		expect(api.calls.map((call) => list(call.handles).length)).toEqual([20, 10, 0]);
		for (const call of api.calls) expect((call.handles ?? "").length).toBeLessThanOrEqual(4000);
	});

	// A view asks for its people one time. A lost answer must not hide them while the view shows.
	it("sends a failed call again after 2 s, without a second ask of a view", async () => {
		vi.useFakeTimers();
		const bot = entry("bot");
		const api = server([bot]);
		const people = createPeople(api.lookup);
		api.fail(true);
		people.want({ ids: [bot.id], handles: ["bot"] });
		await vi.advanceTimersByTimeAsync(0);
		expect(api.calls).toHaveLength(1);
		expect(people.directory().byId.has(bot.id)).toBe(false);
		api.fail(false);
		await vi.advanceTimersByTimeAsync(2000);
		expect(api.calls).toEqual([api.calls[0], api.calls[0]]);
		expect(people.directory().byHandle.get("bot")).toEqual(bot);
	});

	// A server that stays down must not get a call each 2 s for the life of the page.
	it("stops after 3 failed calls, and asks again when a view needs the people again", async () => {
		vi.useFakeTimers();
		const bot = entry("bot");
		const api = server([bot]);
		const people = createPeople(api.lookup);
		api.fail(true);
		people.want({ ids: [bot.id] });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(api.calls).toHaveLength(3);
		api.fail(false);
		people.want({ ids: [bot.id] });
		await vi.advanceTimersByTimeAsync(0);
		expect(api.calls).toHaveLength(4);
		expect(people.directory().byId.get(bot.id)).toEqual(bot);
	});
});

describe("the people of a page after the person leaves Chat", () => {
	// While the server is down, a store without views must not send its failed calls again, or the calls
	// of its queue: nothing shows their answers.
	it("sends no call while it is not active, and sends the calls of its queue when it is active again", async () => {
		vi.useFakeTimers();
		const api = server([]);
		const people = createPeople(api.lookup);
		api.fail(true);
		people.want({ ids: Array.from({ length: 150 }, (_, index) => `prn_${index}`) });
		await vi.advanceTimersByTimeAsync(0);
		expect(api.calls).toHaveLength(1);
		people.setActive(false);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(api.calls).toHaveLength(1);
		// The views of the store show again: the ids that did not go out go out.
		api.fail(false);
		people.setActive(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(api.calls.map((call) => list(call.ids).length)).toEqual([100, 50]);
	});
});

describe("the people that the body of a message needs", () => {
	const body: ChatBody = {
		type: "doc",
		content: [
			{
				type: "paragraph",
				content: [
					{ type: "mention", attrs: { id: "prn_ada", label: "ada" } },
					{ type: "text", text: " and @Bot, not " },
					{ type: "text", text: "@code", marks: [{ type: "code" }] },
					{ type: "text", text: "@linked", marks: [{ type: "link", attrs: { href: "https://example.com/" } }] },
				],
			},
			{
				type: "blockquote",
				content: [
					{
						type: "bullet_list",
						content: [
							{
								type: "list_item",
								content: [
									{
										type: "paragraph",
										content: [
											{ type: "mention", attrs: { id: "prn_zed", label: "zed" } },
											{ type: "text", text: " @bot @quinn@example.com" },
										],
									},
								],
							},
						],
					},
				],
			},
			{ type: "code_block", content: [{ type: "text", text: "@block" }] },
		],
	};

	// The room makes no mention in code or in a link, so the page must not ask for those handles.
	it("is the ids of its mention nodes and the handles of its texts, in each block, without code and links", () => {
		expect(bodyPeople(body, "")).toEqual({ ids: ["prn_ada", "prn_zed"], handles: ["bot", "quinn@example.com"] });
	});

	// A message from an older server has no body. Its mentions are in its text.
	it("is the handles of the text for a message without a body", () => {
		expect(bodyPeople(undefined, "Hi @Ada, mail ada@example.com")).toEqual({ ids: [], handles: ["ada"] });
	});
});
