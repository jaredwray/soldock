import {
	AGENT_SCOPES,
	ALL_SCOPES,
	ApiError,
	type OperationName,
	operations,
	type Scope,
	SetupInput,
} from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import { localOrigin, type SeedApi, SeedStop } from "../src/api.ts";
import { runSeed } from "../src/run.ts";

interface Call {
	name: OperationName;
	input: Record<string, unknown>;
}

/**
 * An Asterra test server that stores nothing. It checks each request as the REST adapter does: the body against
 * the input schema of the operation, and the credential against the callers and the scopes of the
 * operation. It returns only the fields that the seed reads.
 */
function fakeAsterra(options: { ownerExists?: boolean } = {}) {
	const calls: Call[] = [];
	const problems: string[] = [];
	const deliveries: string[] = [];
	/** The addresses that can receive mail: each principal and each team mailbox. */
	const addresses = new Set<string>();
	const callers = new Map<string, { kind: "human" | "agent"; scopes: readonly Scope[] }>();
	const subjects = new Set<string>();
	/** The kind of each principal, by id. */
	const kinds = new Map<string, "human" | "agent">();
	let counter = 0;
	const id = (prefix: string) => `${prefix}_${String(++counter).padStart(26, "0")}`;

	function key(kind: "human" | "agent", scopes: readonly Scope[]) {
		const secret = `secret-${id("key")}`;
		callers.set(secret, { kind, scopes });
		return { secret };
	}

	function principal(kind: "human" | "agent", address: string) {
		addresses.add(address);
		const principalId = id("prn");
		kinds.set(principalId, kind);
		return { id: principalId };
	}

	const outputs: Partial<Record<OperationName, (input: Record<string, unknown>) => unknown>> = {
		// As the server: a new agent gets each agent scope and a first key that acts with them, and a new person
		// gets no key.
		"directory.create_principal": (input) => {
			const kind = input.kind as "human" | "agent";
			return {
				principal: principal(kind, input.address as string),
				api_key: kind === "agent" ? key(kind, AGENT_SCOPES) : null,
			};
		},
		"account.create_api_key": (input) => {
			const kind = kinds.get(input.principal_id as string);
			if (!kind) problems.push("account.create_api_key: the principal is not one that Asterra returned");
			return { api_key: key(kind ?? "human", input.scopes as Scope[]) };
		},
		"directory.create_team_mailbox": (input) => {
			addresses.add(input.address as string);
			return { team_mailbox: { id: id("tmb") } };
		},
		"mail.create_label": () => ({ id: id("lbl") }),
		// Each thread that the seed looks for exists, with each of its messages.
		"mail.list_threads": () => ({
			threads: [...subjects].map((subject) => ({ id: id("thr"), subject, message_count: 99 })),
			next_cursor: null,
		}),
		"mail.get_thread": () => ({ messages: [{ id: id("msg"), message_id_header: "<earlier@example.org>" }] }),
		"mail.send": (input) => {
			if (typeof input.subject === "string") subjects.add(input.subject);
			return {};
		},
		"chat.create_room": () => ({ room: { id: id("rm") } }),
		"chat.open_dm": () => ({ room: { id: id("dm") } }),
		// The rules of the server that the input schema cannot hold: a person is a manager, and an agent is not.
		"drive.create_shared_drive": (input) => {
			const members = input.members as { principal_id: string; role: string }[];
			const managers = members.filter((member) => member.role === "manager").map((m) => kinds.get(m.principal_id));
			if (!managers.includes("human")) problems.push("drive.create_shared_drive: no person is a manager");
			if (managers.includes("agent")) problems.push("drive.create_shared_drive: an agent is a manager");
			if (members.some((member) => !kinds.has(member.principal_id))) {
				problems.push("drive.create_shared_drive: a member is not a principal that Asterra returned");
			}
			return { shared_drive: { id: id("drv") } };
		},
		"drive.create_folder": () => ({ item: { id: id("itm") } }),
		"drive.upload_file": () => ({ item: { id: id("itm") } }),
		"docs.create": () => ({ item: { id: id("itm") } }),
		"sheets.create": () => ({ item: { id: id("itm") } }),
	};

	const api: SeedApi = {
		async setup(input) {
			if (options.ownerExists) throw new ApiError(409, { code: "conflict" });
			const parsed = SetupInput.safeParse(input);
			if (!parsed.success) problems.push(`setup: ${parsed.error.message}`);
			return { principal: principal("human", input.address), api_key: key("human", ALL_SCOPES) } as never;
		},
		async call(apiKey, name, input) {
			calls.push({ name, input: input as Record<string, unknown> });
			const operation = operations[name];
			const parsed = operation.input.safeParse(input);
			if (!parsed.success) problems.push(`${name}: ${parsed.error.message}`);
			const caller = callers.get(apiKey);
			if (!caller) problems.push(`${name}: the credential is not one that Asterra returned`);
			else if (!(operation.callers as readonly string[]).includes(caller.kind)) {
				problems.push(`${name}: a caller of the kind ${caller.kind} cannot call it`);
			} else if (
				!operation.scopes.every((scope) => caller.scopes.includes(scope)) ||
				(operation.anyOfScopes !== undefined && !operation.anyOfScopes.some((scope) => caller.scopes.includes(scope)))
			) {
				problems.push(`${name}: the credential does not hold ${operation.scopes.join(", ")}`);
			}
			return (outputs[name]?.(input as Record<string, unknown>) ?? {}) as never;
		},
		async deliver({ to, raw }) {
			deliveries.push(to);
			const subject = /^Subject: (?:Re: )?(.*)$/m.exec(raw)?.[1];
			if (subject) subjects.add(subject.trim());
		},
	};
	return { api, calls, problems, deliveries, addresses };
}

const noWait = { sleep: async () => {} };

describe("runSeed", () => {
	it("sends only inputs that the operation schemas accept, with a credential that can call the operation", async () => {
		const asterra = fakeAsterra();
		await runSeed(asterra.api, noWait);
		expect(asterra.problems).toEqual([]);
		// The check has a value only if the seed made the calls of each product.
		expect(new Set(asterra.calls.map((call) => call.name))).toEqual(
			new Set([
				"directory.create_principal",
				"account.create_api_key",
				"directory.create_team_mailbox",
				"mail.create_label",
				"mail.list_threads",
				"mail.get_thread",
				"mail.send",
				"mail.modify_threads",
				"chat.create_room",
				"chat.open_dm",
				"chat.post_message",
				"chat.mark_read",
				"drive.create_shared_drive",
				"drive.create_folder",
				"drive.upload_file",
				"drive.share_item",
				"drive.star_items",
				"docs.create",
				"sheets.create",
			]),
		);
	});

	// A member adds the items of a shared drive with the id of that drive. Without space_id, an item
	// goes to the own drive of the member, and the shared drive stays empty.
	it("puts a folder, a doc and a file in the shared drive that it creates", async () => {
		const asterra = fakeAsterra();
		await runSeed(asterra.api, noWait);
		const inSharedDrive = asterra.calls.filter((call) => String(call.input.space_id).startsWith("drv_"));
		expect(new Set(inSharedDrive.map((call) => call.name))).toEqual(
			new Set(["drive.create_folder", "docs.create", "drive.upload_file"]),
		);
	});

	it("addresses mail on its own domain only to mailboxes that it created", async () => {
		const asterra = fakeAsterra();
		await runSeed(asterra.api, noWait);
		const sent = asterra.calls
			.filter((call) => call.name === "mail.send")
			.flatMap((call) => [...(call.input.to as string[]), ...((call.input.cc as string[] | undefined) ?? [])]);
		const local = [...asterra.deliveries, ...sent.filter((address) => address.endsWith("@example.com"))];
		expect(local.length).toBeGreaterThan(0);
		expect(local.filter((address) => !asterra.addresses.has(address))).toEqual([]);
	});

	it("gives each send its own idempotency key, and the same key in each run", async () => {
		const keys: string[][] = [];
		for (let run = 0; run < 2; run++) {
			const asterra = fakeAsterra();
			await runSeed(asterra.api, noWait);
			keys.push(
				asterra.calls.filter((call) => call.name === "mail.send").map((call) => call.input.idempotency_key as string),
			);
		}
		const [first, second] = keys as [string[], string[]];
		expect(first.every((key) => typeof key === "string" && key.length > 0)).toBe(true);
		expect(new Set(first).size).toBe(first.length);
		expect(second).toEqual(first);
	});

	it("stops and makes no call when an owner exists", async () => {
		const asterra = fakeAsterra({ ownerExists: true });
		await expect(runSeed(asterra.api, noWait)).rejects.toBeInstanceOf(SeedStop);
		expect(asterra.calls).toEqual([]);
		expect(asterra.deliveries).toEqual([]);
	});
});

describe("localOrigin", () => {
	it.each([
		["http://localhost:8787", "http://localhost:8787"],
		["http://127.0.0.1:8795/", "http://127.0.0.1:8795"],
	])("accepts %s", (url, origin) => {
		expect(localOrigin(url)).toBe(origin);
	});

	it.each([
		"https://asterra.example.org",
		"http://localhost.example.org:8787",
		"http://localhost@example.org",
		"http://192.168.1.20:8787",
		"file:///localhost",
		"localhost:8787",
	])("refuses %s", (url) => {
		expect(() => localOrigin(url)).toThrow(SeedStop);
	});
});
