// Fills an empty Asterra instance with the made-up organization. Each step is a call that a person or an
// agent can make: the seed has no access to a database or to a Durable Object.
import { ALL_SCOPES, ApiError, type InputOf, OWN_KEY_SCOPES } from "@asterra/contracts";
import { type SeedApi, SeedStop } from "./api.ts";
import { EVENTS, whenOfSeedEvent } from "./calendar.ts";
import {
	type ActorKey,
	AGENTS,
	type AgentKey,
	actorAddress,
	LABELS,
	type LabelName,
	ORGANIZATION,
	OWNER,
	PEOPLE,
	type PersonKey,
	SUPPORT,
} from "./cast.ts";
import { DIRECT_MESSAGES, type Line, ROOMS } from "./chat.ts";
import { DRIVES, type DriveNode, SHARED_DRIVES } from "./drive.ts";
import { composeRaw } from "./eml.ts";
import { MAIL_STEPS, MAIL_TIDY, type MailboxKey, type MailStep } from "./mail.ts";

export interface SeedOptions {
	log?: (line: string) => void;
	/** The wait between two looks at a mailbox. Mail arrives through a queue. */
	sleep?: (ms: number) => Promise<void>;
}

const KEY_PREFIX = "soldock-seed";

/** The person who reads the shared mailbox for the seed. */
const SUPPORT_READER: ActorKey = "ingrid";

const POLL_MS = 500;
const POLL_TRIES = 60;

/** The cell inputs of a grid of rows, from A1. Empty inputs are left out. */
export function cellsOf(rows: string[][]): { cell: string; input: string }[] {
	return rows.flatMap((row, r) =>
		row.flatMap((input, c) => (input === "" ? [] : [{ cell: `${String.fromCharCode(65 + c)}${r + 1}`, input }])),
	);
}

/** The subject of a thread without the reply prefixes. */
function baseSubject(subject: string): string {
	return subject.replace(/^(?:re:\s*)+/i, "");
}

function mailboxAddress(mailbox: MailboxKey): string {
	return mailbox === "support" ? SUPPORT.address : PEOPLE[mailbox].address;
}

/** The number of messages that a mailbox has in the thread with this subject, after each step ran. */
function expectedMessages(mailbox: MailboxKey, subject: string): number {
	const address = mailboxAddress(mailbox);
	return MAIL_STEPS.filter((step) => {
		if (step.subject !== subject) return false;
		if ([...step.to, ...(step.cc ?? [])].includes(address)) return true;
		return step.kind === "send" && (step.fromSupport ? "support" : step.as) === mailbox;
	}).length;
}

export async function runSeed(api: SeedApi, options: SeedOptions = {}): Promise<void> {
	const log = options.log ?? (() => {});
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const apiKeys = new Map<ActorKey, string>();
	const principalIds = new Map<ActorKey, string>();
	const keyOf = (actor: ActorKey) => apiKeys.get(actor) as string;
	const idOf = (actor: ActorKey) => principalIds.get(actor) as string;

	// 1. Setup. It is one transaction: it creates the owner only if the directory is empty.
	const owner = PEOPLE[OWNER];
	try {
		const result = await api.setup({
			mail_domain: ORGANIZATION.mailDomain,
			display_name: owner.displayName,
			address: owner.address,
			password: owner.password,
		});
		apiKeys.set(OWNER, result.api_key.secret);
		principalIds.set(OWNER, result.principal.id);
	} catch (error) {
		if (error instanceof ApiError && error.code === "conflict") {
			throw new SeedStop(
				"This Asterra instance has an owner already. The seed fills only an empty Asterra instance, and it changed nothing. " +
					"Start the Worker with a new, empty --persist-to directory, apply the migrations to it, and run the seed again.",
			);
		}
		throw error;
	}
	log(`Setup: ${owner.displayName} is the owner, and the mail domain is ${ORGANIZATION.mailDomain}.`);

	// 2. The people, the agents and the shared mailbox.
	for (const key of Object.keys(PEOPLE) as PersonKey[]) {
		if (key === OWNER) continue;
		const person = PEOPLE[key];
		const created = await api.call(keyOf(OWNER), "directory.create_principal", {
			kind: "human",
			display_name: person.displayName,
			address: person.address,
			org_role: person.orgRole,
			password: person.password,
		});
		principalIds.set(key, created.principal.id);
		// A new person gets no API key. The owner creates one, so the seed can act as the person. Only the person
		// gives a key the scopes of OWN_KEY_SCOPES, and the seed does not need them.
		const personKey = await api.call(keyOf(OWNER), "account.create_api_key", {
			principal_id: created.principal.id,
			label: "Seed",
			scopes: ALL_SCOPES.filter((scope) => !OWN_KEY_SCOPES.includes(scope)),
		});
		apiKeys.set(key, personKey.api_key.secret);
	}
	for (const key of Object.keys(AGENTS) as AgentKey[]) {
		const agent = AGENTS[key];
		const created = await api.call(keyOf(OWNER), "directory.create_principal", {
			kind: "agent",
			display_name: agent.displayName,
			address: agent.address,
			sponsor_id: idOf(agent.sponsor),
		});
		if (!created.api_key) throw new Error(`The agent ${agent.displayName} got no first API key.`);
		apiKeys.set(key, created.api_key.secret);
		principalIds.set(key, created.principal.id);
	}
	const support = await api.call(keyOf(OWNER), "directory.create_team_mailbox", {
		display_name: SUPPORT.displayName,
		address: SUPPORT.address,
		member_ids: SUPPORT.members.map(idOf),
	});
	const supportId = support.team_mailbox.id;
	log(`Directory: ${Object.keys(PEOPLE).length} people, ${Object.keys(AGENTS).length} agents, 1 shared mailbox.`);

	// 3. Mail.
	const labelIds = new Map<LabelName, string>();
	for (const name of LABELS) {
		const label = await api.call(keyOf(OWNER), "mail.create_label", { name });
		labelIds.set(name, label.id);
	}

	/** Waits for the thread with this subject, with at least this number of messages, and returns its id. */
	async function waitForThread(mailbox: MailboxKey, subject: string, messages = 1): Promise<string> {
		const reader = keyOf(mailbox === "support" ? SUPPORT_READER : mailbox);
		const mailbox_id = mailbox === "support" ? supportId : undefined;
		for (let attempt = 0; attempt < POLL_TRIES; attempt++) {
			if (attempt > 0) await sleep(POLL_MS);
			const page = await api.call(reader, "mail.list_threads", { mailbox_id, query: "in:anywhere", limit: 100 });
			const thread = page.threads.find((t) => baseSubject(t.subject) === subject && t.message_count >= messages);
			if (thread) return thread.id;
		}
		throw new Error(`The message "${subject}" did not arrive in the mailbox ${mailboxAddress(mailbox)}.`);
	}

	/** The newest message of a thread: a reply answers it. */
	async function newestMessage(mailbox: MailboxKey, subject: string) {
		const reader = keyOf(mailbox === "support" ? SUPPORT_READER : mailbox);
		const mailbox_id = mailbox === "support" ? supportId : undefined;
		const thread_id = await waitForThread(mailbox, subject);
		const thread = await api.call(reader, "mail.get_thread", { mailbox_id, thread_id });
		const newest = thread.messages.at(-1);
		if (!newest) throw new Error(`The thread "${subject}" has no message.`);
		return newest;
	}

	async function runMailStep(step: MailStep): Promise<void> {
		if (step.kind === "inbound") {
			const inReplyTo = step.replyIn
				? ((await newestMessage(step.replyIn, step.subject)).message_id_header ?? undefined)
				: undefined;
			const cc = step.cc ?? [];
			const raw = composeRaw({
				id: step.id,
				from: step.from,
				to: step.to,
				cc,
				subject: step.replyIn ? `Re: ${step.subject}` : step.subject,
				text: step.text,
				inReplyTo,
				date: new Date(),
			});
			// An outside mail server delivers one copy for each recipient of this deployment.
			const local = [...step.to, ...cc].filter((address) => address.endsWith(`@${ORGANIZATION.mailDomain}`));
			for (const to of local) await api.deliver({ from: step.from.address, to, raw });
			return;
		}
		const mailbox: MailboxKey = step.fromSupport ? "support" : (step.as as PersonKey);
		const input: InputOf<"mail.send"> = {
			mailbox_id: step.fromSupport ? supportId : undefined,
			to: step.to,
			cc: step.cc,
			text: step.text,
			idempotency_key: `${KEY_PREFIX}/mail/${step.id}`,
		};
		if (step.reply) input.reply_to_message_id = (await newestMessage(mailbox, step.subject)).id;
		else input.subject = step.subject;
		await api.call(keyOf(step.as), "mail.send", input);
	}

	for (const step of MAIL_STEPS) await runMailStep(step);
	for (const tidy of MAIL_TIDY) {
		const thread_id = await waitForThread(tidy.mailbox, tidy.subject, expectedMessages(tidy.mailbox, tidy.subject));
		await api.call(keyOf(tidy.mailbox === "support" ? SUPPORT_READER : tidy.mailbox), "mail.modify_threads", {
			mailbox_id: tidy.mailbox === "support" ? supportId : undefined,
			thread_ids: [thread_id],
			add_label_ids: [
				...(tidy.labels ?? []).map((name) => labelIds.get(name) as string),
				...(tidy.starred ? ["STARRED"] : []),
			],
			remove_label_ids: tidy.read ? ["UNREAD"] : [],
		});
	}
	log(`Mail: ${MAIL_STEPS.length} messages, ${LABELS.length} labels.`);

	// 4. Chat. Each author posts their own messages.
	async function post(roomId: string, conversation: string, lines: Line[]): Promise<void> {
		for (const [index, [author, text]] of lines.entries()) {
			await api.call(keyOf(author), "chat.post_message", {
				room_id: roomId,
				text,
				idempotency_key: `${KEY_PREFIX}/chat/${conversation}/${index}`,
			});
		}
	}
	for (const room of ROOMS) {
		const [creator, ...others] = room.members as [ActorKey, ...ActorKey[]];
		const created = await api.call(keyOf(creator), "chat.create_room", {
			kind: room.kind,
			name: room.name,
			topic: room.topic,
			member_ids: others.map(idOf),
		});
		await post(created.room.id, room.id, room.lines);
		if (room.ownerRead) await api.call(keyOf(OWNER), "chat.mark_read", { room_id: created.room.id });
	}
	for (const dm of DIRECT_MESSAGES) {
		const opened = await api.call(keyOf(dm.between[0]), "chat.open_dm", { principal_id: idOf(dm.between[1]) });
		await post(opened.room.id, dm.id, dm.lines);
	}
	log(`Chat: ${ROOMS.length} rooms, ${DIRECT_MESSAGES.length} direct messages.`);

	// 5. Drive. Each owner creates their own items, then shares them.
	// `space_id` is the id of a shared drive, or undefined for the own drive of the actor.
	async function createNode(
		actor: ActorKey,
		node: DriveNode,
		parent_id: string | undefined,
		space_id?: string,
	): Promise<void> {
		const apiKey = keyOf(actor);
		const common = { space_id, parent_id, name: node.name, idempotency_key: `${KEY_PREFIX}/drive/${node.id}` };
		let itemId: string;
		if (node.kind === "folder") {
			itemId = (await api.call(apiKey, "drive.create_folder", common)).item.id;
		} else if (node.kind === "doc") {
			itemId = (await api.call(apiKey, "docs.create", { ...common, markdown: node.markdown })).item.id;
		} else if (node.kind === "sheet") {
			itemId = (await api.call(apiKey, "sheets.create", { ...common, cells: cellsOf(node.rows) })).item.id;
		} else {
			const upload = await api.call(apiKey, "drive.upload_file", {
				...common,
				mime_type: node.mimeType,
				content_base64: Buffer.from(node.text, "utf8").toString("base64"),
			});
			itemId = upload.item.id;
		}
		if (node.kind === "folder") for (const child of node.children) await createNode(actor, child, itemId, space_id);
		for (const share of node.share ?? []) {
			await api.call(apiKey, "drive.share_item", {
				space_id,
				item_id: itemId,
				principal_id: idOf(share.with),
				role: share.role,
			});
		}
		if (node.starred) await api.call(apiKey, "drive.star_items", { space_id, item_ids: [itemId], starred: true });
	}
	for (const drive of DRIVES) for (const node of drive.items) await createNode(drive.owner, node, undefined);
	// Only an owner or an admin creates a shared drive. A member with the editor role adds the items.
	for (const drive of SHARED_DRIVES) {
		const created = await api.call(keyOf(OWNER), "drive.create_shared_drive", {
			name: drive.name,
			members: drive.members.map((member) => ({ principal_id: idOf(member.who), role: member.role })),
			idempotency_key: `${KEY_PREFIX}/shared-drive/${drive.id}`,
		});
		for (const node of drive.items) await createNode(drive.author, node, undefined, created.shared_drive.id);
	}
	log(
		`Drive: the items of ${DRIVES.length} drives, with their shares, and ${SHARED_DRIVES.length} shared drive (${SHARED_DRIVES.map((drive) => drive.name).join(", ")}).`,
	);

	// 6. Calendar. Each person and agent adds the events of its own calendar, from the day of the seed.
	const seedDay = new Date().toISOString().slice(0, 10);
	for (const event of EVENTS) {
		await api.call(keyOf(event.owner), "calendar.create_event", {
			title: event.title,
			when: whenOfSeedEvent(event, seedDay),
			...(event.location ? { location: event.location } : {}),
			...(event.description ? { description: event.description } : {}),
			idempotency_key: `${KEY_PREFIX}/calendar/${event.id}`,
		});
	}
	log(
		`Calendar: ${EVENTS.length} events in the calendars of ${new Set(EVENTS.map((event) => event.owner)).size} people and agents.`,
	);
}

/** The lines that say how to sign in as each person. */
export function signInLines(origin: string): string[] {
	const people = Object.values(PEOPLE);
	const width = (pick: (person: (typeof people)[number]) => string) => Math.max(...people.map((p) => pick(p).length));
	const nameWidth = width((p) => p.displayName);
	const addressWidth = Math.max(...[...people, ...Object.values(AGENTS)].map((p) => p.address.length));
	const passwordWidth = width((p) => p.password);
	return [
		`${ORGANIZATION.name}: ${ORGANIZATION.tagline}`,
		"",
		`Open ${origin} and sign in as one of the people. Each person is made up.`,
		"If the setup page shows first, select Continue with the existing accounts.",
		"",
		...people.map(
			(p) =>
				`  ${p.displayName.padEnd(nameWidth)}  ${p.address.padEnd(addressWidth)}  ${p.password.padEnd(passwordWidth)}  ${p.job} (${p.orgRole})`,
		),
		"",
		"Agents do not sign in. They use API keys.",
		...Object.values(AGENTS).map(
			(a) =>
				`  ${a.displayName.padEnd(nameWidth)}  ${a.address.padEnd(addressWidth)}  Sponsor: ${PEOPLE[a.sponsor].displayName}`,
		),
		"",
		`Shared mailbox: ${SUPPORT.displayName} <${SUPPORT.address}>, for ${SUPPORT.members.map((m) => actorAddress(m).split("@")[0]).join(", ")}.`,
		...SHARED_DRIVES.map(
			(drive) =>
				`Shared drive: ${drive.name}, for ${drive.members.map((m) => `${actorAddress(m.who).split("@")[0]} (${m.role})`).join(", ")}.`,
		),
	];
}
