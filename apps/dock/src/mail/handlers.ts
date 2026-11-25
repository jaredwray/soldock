import {
	MAIL_LIMITS,
	MAILBOX_MEMBER_SCOPES,
	type MailboxMemberScope,
	type Message,
	mailboxMemberScopes,
	operations,
} from "@asterra/contracts";
import { autoLabelUnavailableReason } from "../ai/index.ts";
import {
	agentMailboxes,
	agentMailboxFor,
	type CallContext,
	canReadAgentMailboxes,
	domainOf,
	holdsForResource,
	isAdmin,
	isTeamMailboxId,
	type MailboxRecord,
	mailDomains,
	resolveMailboxAddress,
	teamMailboxesOf,
	teamMailboxFor,
} from "../identity/index.ts";
import {
	audit,
	base64ToBytes,
	bytesToBase64,
	type HandlerMap,
	log,
	newId,
	OperationError,
	sha256Hex,
} from "../platform/index.ts";
import { mailboxStub, storeRaw } from "./delivery.ts";
import type { Refusal, SendInput, SettingsPatch, StoredMessage } from "./mailbox.ts";
import { composeMessage } from "./mime/compose.ts";
import { parseMail, readAttachment } from "./mime/parse.ts";
import { readOrgSettings, screenerDefault, updateOrgSettings } from "./org-settings.ts";
import { deniedOutboundAddresses, outboundMode, outboundPolicyDenial } from "./outbound.ts";
import { sanitizeHtml } from "./sanitize.ts";
import type { ScreenerContext, ScreenerSenderRecord } from "./screener/store.ts";
import { screenerEnabled } from "./screener/store.ts";
import { compileQuery, parseQuery, QueryError } from "./search.ts";
import { htmlToText, replySubject } from "./threading.ts";
import { webhookHandlers } from "./webhooks.ts";

type MailOperation =
	| "mail.list_mailboxes"
	| "mail.get_settings"
	| "mail.update_settings"
	| "mail.get_mailbox_settings"
	| "mail.update_mailbox_settings"
	| "mail.get_org_settings"
	| "mail.update_org_settings"
	| "mail.list_screener"
	| "mail.screen_sender"
	| "mail.get_auto_labels"
	| "mail.update_auto_labels"
	| "mail.create_auto_label"
	| "mail.delete_auto_label"
	| "mail.run_auto_labels"
	| "mail.get_profile"
	| "mail.list_labels"
	| "mail.create_label"
	| "mail.delete_label"
	| "mail.list_threads"
	| "mail.get_thread"
	| "mail.get_message"
	| "mail.modify_threads"
	| "mail.send"
	| "mail.suggest_recipients"
	| "mail.get_attachment"
	| "mail.create_webhook_subscription"
	| "mail.list_webhook_subscriptions"
	| "mail.delete_webhook_subscription";

const DEFAULT_QUERY = "in:inbox";
const DEFAULT_PAGE = 25;
const DEFAULT_SUGGESTIONS = 10;

/** The own mailbox of the caller. Its id is the id of the principal. */
function ownMailbox(call: CallContext): MailboxRecord {
	const { principal } = call.caller;
	return { id: principal.id, kind: "personal", address: principal.address, display_name: principal.display_name };
}

/**
 * The mailbox of a call: the own mailbox of the caller by default, or a team mailbox that the caller
 * is a member of. An owner or an admin can also read the own mailbox of an agent, but cannot change it
 * or send from it. This is the resource check of each mail operation. The scopes of the credential
 * decide what the caller can do, and this decides in which mailbox.
 *
 * In a team mailbox, the membership has scopes too. The call needs each mail scope of its operation in the
 * membership (`mailboxMemberScopes`). The contract of the operation names them, so a handler cannot ask for
 * a different scope than the invoker did. `also` names a scope that one input of the operation needs more.
 */
async function openMailbox(
	call: CallContext,
	mailboxId: string | undefined,
	operation: MailOperation,
	also: readonly MailboxMemberScope[] = [],
) {
	const needed = [...new Set([...mailboxMemberScopes(operations[operation].scopes), ...also])];
	let record: MailboxRecord;
	if (mailboxId === undefined || mailboxId === call.caller.id) record = ownMailbox(call);
	else if (isTeamMailboxId(mailboxId)) {
		record = await teamMailboxFor(call.env.DIRECTORY, mailboxId, call.caller.id, needed);
	} else if (canReadAgentMailboxes(call.caller)) {
		record = await agentMailboxFor(call.env.DIRECTORY, mailboxId);
		// An owner or an admin reads the mail of an agent. A change would change what the agent sees, for
		// example the read state, and a send would come from the address of the agent.
		if (needed.some((scope) => scope !== "mail.read")) {
			throw new OperationError(
				"forbidden",
				"You can read the mailbox of an agent, but you cannot change it or send from it.",
			);
		}
	} else {
		throw new OperationError(
			"forbidden",
			"You can use only your own mailbox and the team mailboxes that you are a member of.",
		);
	}
	return { record, box: mailboxStub(call.env, record.id) };
}

/** Turns a refusal from the mailbox into an OperationError, and returns any other result. */
function accept<T extends object>(value: T): Exclude<T, { error: unknown }> {
	if ("error" in value) {
		const { error } = value as Refusal;
		throw new OperationError(error.code, error.message);
	}
	return value as Exclude<T, { error: unknown }>;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function auditOk(
	call: CallContext,
	mailbox: MailboxRecord,
	op: string,
	target: string,
	extra?: { outboundMode?: string; externalRecipients?: number; code?: string },
): void {
	audit({
		op,
		actor: call.caller.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target,
		...(mailbox.kind === "personal" ? {} : { mailbox: mailbox.id }),
		result: "ok",
		requestId: call.requestId,
		...extra,
	});
}

/**
 * What the mailbox needs to know about the Screener: the default of the organization, and whether the
 * Screener can apply. It applies to the own mailbox of a person and to a team mailbox. It never applies to
 * the own mailbox of an agent or a service account.
 */
async function screenerContext(call: CallContext, record: MailboxRecord): Promise<ScreenerContext> {
	const eligible = record.kind === "team" || (record.kind === "personal" && call.caller.kind === "human");
	return { orgDefault: await screenerDefault(call.env.DIRECTORY), eligible };
}

/** The Screener part of the settings of a mailbox. */
function screenerSettings(mode: "inherit" | "on" | "off", context: ScreenerContext) {
	return { mode, org_default: context.orgDefault, enabled: screenerEnabled(mode, context) };
}

/** Only an owner or an admin reads or changes the mail settings of the organization. Never an agent. */
function requireAdmin(call: CallContext, action: string): void {
	if (!isAdmin(call.caller)) throw new OperationError("forbidden", `Only owners and admins can ${action}.`);
}

function toScreenerSender(record: ScreenerSenderRecord) {
	return {
		address: record.address,
		name: record.name,
		status: record.status,
		messages_held: record.messagesHeld,
		first_seen_at: iso(record.firstSeenAt),
		latest: record.latest
			? {
					thread_id: record.latest.threadId,
					message_id: record.latest.messageId,
					subject: record.latest.subject,
					snippet: record.latest.snippet,
					received_at: iso(record.latest.receivedAt),
					has_attachments: record.latest.hasAttachments,
				}
			: null,
		decided_at: record.decidedAt === null ? null : iso(record.decidedAt),
		decided_by: record.decidedBy,
		untrusted: true as const,
	};
}

/**
 * An owner or an admin who reads the mail of an agent gets an audit line, so the operator can see who
 * read what. Reads in the own mailbox and in team mailboxes get no line.
 */
function auditAgentRead(call: CallContext, mailbox: MailboxRecord, op: string, target: string): void {
	if (mailbox.kind === "agent") auditOk(call, mailbox, op, target);
}

/**
 * Sanitizes the HTML of one message. A message that the sanitizer cannot read loses its HTML (the
 * plain text stays), so one hostile message can never make its whole thread unreadable.
 */
async function safeHtml(stored: StoredMessage): Promise<{ html: string; remoteImagesBlocked: number } | null> {
	if (stored.html === null) return null;
	try {
		return await sanitizeHtml(stored.html);
	} catch (error) {
		log("warn", "message HTML could not be sanitized; it is left out", {
			messageId: stored.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

async function toMessage(stored: StoredMessage): Promise<Message> {
	const html = await safeHtml(stored);
	return {
		id: stored.id,
		thread_id: stored.threadId,
		message_id_header: stored.messageIdHeader,
		from: stored.from,
		to: stored.to,
		cc: stored.cc,
		bcc: stored.origin === "sent" ? stored.bcc : [],
		reply_to: stored.replyTo,
		subject: stored.subject,
		date: iso(stored.sentDate),
		received_at: iso(stored.internalDate),
		label_ids: stored.labels,
		auto_label_ids: stored.autoLabels,
		snippet: stored.snippet,
		origin: stored.origin,
		untrusted: stored.origin === "external",
		authentication: stored.origin === "external" ? stored.authentication : null,
		body: {
			// When the HTML cannot be sanitized and the message has no text part, a text form keeps it readable.
			text: stored.text ?? (html === null && stored.html !== null ? htmlToText(stored.html) : null),
			html: html?.html ?? null,
			remote_images_blocked: html?.remoteImagesBlocked ?? 0,
			truncated: stored.truncated,
			omitted: stored.omitted,
		},
		attachments: stored.attachments.map((a) => ({
			index: a.index,
			filename: a.filename,
			mime_type: a.mimeType,
			size: a.size,
			inline: a.inline,
		})),
		delivery: stored.delivery,
		sent_by: stored.sentBy,
	};
}

interface Recipient {
	address: string;
	kind: "local" | "external";
	/** The mailbox of a local recipient: the id of a principal or of a team mailbox. */
	mailboxId: string | null;
	/** True when the recipient is the mailbox that sends the message. */
	self: boolean;
}

/**
 * Sorts the recipients into mailboxes of this deployment and external addresses. Each address
 * gets one delivery, and each local mailbox gets one copy, also when two of its addresses appear.
 */
async function resolveRecipients(call: CallContext, sender: MailboxRecord, addresses: string[]): Promise<Recipient[]> {
	const domains = await mailDomains(call.env.DIRECTORY);
	const byAddress = new Map<string, Recipient>();
	const localMailboxes = new Set<string>();
	for (const raw of addresses) {
		// The lowercase form is the key for duplicates and policy. An external envelope keeps the case
		// of its local part, which RFC 5321 lets the receiving server treat as significant.
		const key = raw.trim().toLowerCase();
		if (byAddress.has(key)) continue;
		if (!domains.has(domainOf(key))) {
			byAddress.set(key, { address: normalizeCase(raw.trim()), kind: "external", mailboxId: null, self: false });
			continue;
		}
		const address = key;
		const recipient = await resolveMailboxAddress(call.env.DIRECTORY, address);
		if (!recipient) throw new OperationError("not_found", `No mailbox has the address ${address}.`);
		if (localMailboxes.has(recipient.id)) continue;
		localMailboxes.add(recipient.id);
		byAddress.set(key, { address, kind: "local", mailboxId: recipient.id, self: recipient.id === sender.id });
	}
	return [...byAddress.values()];
}

/**
 * Refuses an agent send to recipients outside its outbound policy, before anything is stored. The
 * policy belongs to the agent, not to the mailbox: it also applies to mail from a team mailbox, so a
 * team mailbox never widens what an agent can reach.
 */
function checkOutboundPolicy(call: CallContext, recipients: Recipient[]): void {
	const { principal } = call.caller;
	const external = recipients.filter((r) => r.kind === "external").map((r) => r.address.toLowerCase());
	const denied = deniedOutboundAddresses(principal, external);
	if (denied.length > 0) {
		throw new OperationError("policy_denied", outboundPolicyDenial(outboundMode(principal), denied));
	}
}

export const mailHandlers: Pick<HandlerMap<CallContext>, MailOperation> = {
	...webhookHandlers,

	async "mail.list_mailboxes"(call) {
		const [teams, agents] = await Promise.all([
			teamMailboxesOf(call.env.DIRECTORY, call.caller.id),
			canReadAgentMailboxes(call.caller) ? agentMailboxes(call.env.DIRECTORY) : [],
		]);
		// A person can do each thing in their own mailbox. An agent or a service account can do what its account
		// scopes allow there. In a team mailbox, the membership decides for each principal.
		const own =
			call.caller.principal.kind === "agent"
				? MAILBOX_MEMBER_SCOPES.filter((scope) => call.caller.scopes.has(scope))
				: [...MAILBOX_MEMBER_SCOPES];
		const mailboxes = [
			{ ...ownMailbox(call), service: call.caller.kind === "service", scopes: own },
			...teams.map((mailbox) => ({ ...mailbox, service: false })),
			// An owner or an admin can read the mailbox of an agent or a service account, and nothing more.
			...agents.map((mailbox) => ({ ...mailbox, scopes: ["mail.read"] })),
		];
		return { mailboxes };
	},

	// The settings of a person live in their own mailbox. These operations take no mailbox_id, so a member
	// of a team mailbox never changes the settings of the other members.
	async "mail.get_settings"(call) {
		return mailboxStub(call.env, call.caller.id).settings();
	},

	async "mail.update_settings"(call, input) {
		let defaultFrom: SettingsPatch["default_from"];
		if (input.default_from) {
			const { mailbox_id: mailboxId } = input.default_from;
			const own = (id: string) => id === call.caller.id;
			// The web app composes in the own mailbox or in a team mailbox. Nobody writes from the mailbox of an
			// agent, and the mailbox of a different person is private.
			if (!own(mailboxId) && !isTeamMailboxId(mailboxId)) {
				throw new OperationError(
					"invalid",
					"The mailbox in default_from must be your own mailbox or a team mailbox that you are a member of.",
				);
			}
			// The same id means the address of the mailbox itself, which is the default.
			const fromId = input.default_from.from_mailbox_id === mailboxId ? null : input.default_from.from_mailbox_id;
			if (fromId !== null && !own(fromId) && !isTeamMailboxId(fromId)) {
				throw new OperationError(
					"invalid",
					"You can send only from your own address and from the address of a team mailbox that you are a member of.",
				);
			}
			// A removal needs no membership, so a person can remove a setting after a membership ended.
			if (fromId !== null) {
				if (!own(mailboxId)) await teamMailboxFor(call.env.DIRECTORY, mailboxId, call.caller.id, ["mail.read"]);
				if (!own(fromId)) await teamMailboxFor(call.env.DIRECTORY, fromId, call.caller.id, ["mail.send"]);
			}
			defaultFrom = { mailbox_id: mailboxId, from_mailbox_id: fromId };
		}
		return mailboxStub(call.env, call.caller.id).updateSettings({ sidebar: input.sidebar, default_from: defaultFrom });
	},

	// The settings of a mailbox live in that mailbox, so the members of a team mailbox share them.
	async "mail.get_mailbox_settings"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.get_mailbox_settings");
		// No audit line, as for mail.get_profile: the settings hold no mail content.
		const [settings, context] = await Promise.all([box.mailboxSettings(), screenerContext(call, record)]);
		return {
			mailbox_id: record.id,
			signature: settings.signature,
			screener: screenerSettings(settings.screener, context),
		};
	},

	async "mail.update_mailbox_settings"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.update_mailbox_settings");
		// The members of a team mailbox share its signature, and the web composer adds it to the mail of each
		// person. An agent that a message tricks could put text into that mail, so only people change it there.
		if (call.caller.kind !== "human" && record.kind !== "personal") {
			throw new OperationError(
				"forbidden",
				"An agent or a service account can change only the settings of its own mailbox.",
			);
		}
		const context = await screenerContext(call, record);
		// The mailbox of an agent has no Screener: nobody but the agent could decide there, from untrusted mail.
		if (input.screener !== undefined && !context.eligible) {
			throw new OperationError("forbidden", "The Screener is for the mailboxes of people and for team mailboxes.");
		}
		const settings = await box.updateMailboxSettings({ signature: input.signature, screener: input.screener }, context);
		// The line names the mailbox only. It never holds the signature.
		auditOk(
			call,
			record,
			"mail.update_mailbox_settings",
			record.id,
			input.screener === undefined ? undefined : { code: `screener_${input.screener}` },
		);
		return {
			mailbox_id: record.id,
			signature: settings.signature,
			screener: screenerSettings(settings.screener, context),
		};
	},

	async "mail.get_org_settings"(call) {
		requireAdmin(call, "read the mail settings of the organization");
		return readOrgSettings(call.env.DIRECTORY);
	},

	async "mail.update_org_settings"(call, input) {
		requireAdmin(call, "change the mail settings of the organization");
		const settings = await updateOrgSettings(call.env.DIRECTORY, input, Date.now());
		// One audit line for each setting in the request.
		const auditSetting = (target: string, code: string) =>
			audit({
				op: "mail.update_org_settings",
				actor: call.caller.id,
				actorKind: call.caller.kind,
				credential: call.caller.credential,
				target,
				code,
				result: "ok",
				requestId: call.requestId,
			});
		if (input.screener) auditSetting("screener", settings.screener.default_enabled ? "on" : "off");
		if (input.address_format) {
			auditSetting("address_format", settings.address_format.enabled ? settings.address_format.format : "off");
		}
		return settings;
	},

	async "mail.list_screener"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.list_screener");
		const page = accept(
			await box.listScreener({
				status: input.status,
				cursor: input.cursor ?? null,
				limit: input.limit ?? DEFAULT_PAGE,
			}),
		);
		auditAgentRead(call, record, "mail.list_screener", record.id);
		return { senders: page.senders.map(toScreenerSender), next_cursor: page.nextCursor };
	},

	async "mail.screen_sender"(call, input) {
		// The contract lets only people call it. In the mailbox of an agent, openMailbox refuses a change.
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.screen_sender");
		const { principal } = call.caller;
		const result = await box.screenSender({
			address: input.address,
			decision: input.decision,
			by: { principal_id: principal.id, kind: "human", display_name: principal.display_name },
			dryRun: input.dry_run,
			now: Date.now(),
		});
		// The line names the mailbox and the decision. The address of the sender stays out of the log.
		if (!input.dry_run) auditOk(call, record, "mail.screen_sender", record.id, { code: input.decision });
		return result;
	},

	async "mail.get_auto_labels"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.get_auto_labels");
		const [settings, reason] = await Promise.all([box.autoLabelSettings(), autoLabelUnavailableReason(call.env)]);
		auditAgentRead(call, record, "mail.get_auto_labels", record.id);
		return { mailbox_id: record.id, ...settings, available: reason === null, unavailable_reason: reason };
	},

	async "mail.update_auto_labels"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.update_auto_labels");
		const settings = accept(await box.updateAutoLabels(record.id, { enabled: input.enabled, labels: input.labels }));
		auditOk(call, record, "mail.update_auto_labels", record.id);
		const reason = await autoLabelUnavailableReason(call.env);
		return { mailbox_id: record.id, ...settings, available: reason === null, unavailable_reason: reason };
	},

	async "mail.create_auto_label"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.create_auto_label");
		const settings = accept(
			await box.createAutoLabel(record.id, {
				name: input.name,
				description: input.description,
				skipInbox: input.skip_inbox,
			}),
		);
		auditOk(call, record, "mail.create_auto_label", record.id);
		const reason = await autoLabelUnavailableReason(call.env);
		return { mailbox_id: record.id, ...settings, available: reason === null, unavailable_reason: reason };
	},

	async "mail.delete_auto_label"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.delete_auto_label");
		const result = accept(await box.deleteAutoLabel(record.id, input.auto_label_id));
		auditOk(call, record, "mail.delete_auto_label", input.auto_label_id);
		return result;
	},

	async "mail.run_auto_labels"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.run_auto_labels");
		if ((await autoLabelUnavailableReason(call.env)) !== null) {
			throw new OperationError("conflict", "An owner or an admin must turn on AI and inbox auto labels first.");
		}
		const result = accept(await box.runAutoLabels(record.id, record.address, input.limit, input.dry_run));
		if (!input.dry_run) auditOk(call, record, "mail.run_auto_labels", record.id);
		return result;
	},

	async "mail.get_profile"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.get_profile");
		const profile = await box.profile();
		return {
			mailbox_id: record.id,
			kind: record.kind,
			address: record.address,
			display_name: record.display_name,
			mail_domains: [...(await mailDomains(call.env.DIRECTORY))],
			...profile,
		};
	},

	async "mail.list_labels"(call, input) {
		const { box } = await openMailbox(call, input.mailbox_id, "mail.list_labels");
		return { labels: await box.listLabels() };
	},

	async "mail.create_label"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.create_label");
		const label = accept(await box.createLabel(input.name));
		auditOk(call, record, "mail.create_label", label.id);
		return label;
	},

	async "mail.delete_label"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.delete_label");
		const result = accept(await box.deleteLabel(input.label_id));
		auditOk(call, record, "mail.delete_label", input.label_id);
		return result;
	},

	async "mail.list_threads"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.list_threads");
		const query = input.query ?? DEFAULT_QUERY;
		const now = Date.now();
		// "me" in a search is the mailbox: in a team mailbox, from:me finds mail from the team address.
		const self = [record.address];
		try {
			// Fails fast here with a clear error. The mailbox compiles the same query again.
			compileQuery(parseQuery(query), { self, now });
		} catch (error) {
			if (error instanceof QueryError) throw new OperationError("invalid", error.message);
			throw error;
		}
		const result = accept(
			await box.listThreads({
				query,
				cursor: input.cursor ?? null,
				limit: input.limit ?? DEFAULT_PAGE,
				self,
				now,
			}),
		);
		// The query can hold private words, so the audit line names the mailbox only.
		auditAgentRead(call, record, "mail.list_threads", record.id);
		return {
			threads: result.threads.map((thread) => ({
				id: thread.id,
				subject: thread.subject,
				snippet: thread.snippet,
				participants: thread.participants,
				message_count: thread.messageCount,
				unread: thread.labels.includes("UNREAD"),
				starred: thread.labels.includes("STARRED"),
				has_attachments: thread.hasAttachments,
				label_ids: thread.labels,
				auto_label_ids: thread.autoLabels,
				last_message_at: iso(thread.lastMessageAt),
				untrusted: thread.untrusted,
			})),
			next_cursor: result.nextCursor,
		};
	},

	async "mail.get_thread"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.get_thread");
		const thread = await box.getThread(input.thread_id);
		if (!thread) throw new OperationError("not_found", "No thread has that id.");
		auditAgentRead(call, record, "mail.get_thread", input.thread_id);
		const messages = await Promise.all(thread.messages.map(toMessage));
		const labelIds = [...new Set(messages.flatMap((m) => m.label_ids))];
		return {
			id: thread.id,
			subject: thread.subject,
			label_ids: labelIds,
			// A label of the thread is an auto label when auto labels applied it to each message that has it.
			auto_label_ids: labelIds.filter((id) =>
				messages.every((m) => !m.label_ids.includes(id) || m.auto_label_ids.includes(id)),
			),
			untrusted: messages.some((m) => m.untrusted),
			messages,
		};
	},

	async "mail.get_message"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.get_message");
		const stored = await box.getMessage(input.message_id);
		if (!stored) throw new OperationError("not_found", "No message has that id.");
		auditAgentRead(call, record, "mail.get_message", input.message_id);
		return toMessage(stored);
	},

	async "mail.modify_threads"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.modify_threads");
		const result = accept(
			await box.modifyThreads({
				threadIds: input.thread_ids,
				add: input.add_label_ids,
				remove: input.remove_label_ids,
				dryRun: input.dry_run,
				// Auto labels learn from the changes of a person only.
				learn: call.caller.kind === "human",
			}),
		);
		if (!input.dry_run) auditOk(call, record, "mail.modify_threads", input.thread_ids.join(","));
		return result;
	},

	async "mail.send"(call, input) {
		// A reply reads the message that it answers: its subject and its references go into the new message.
		// So a reply needs mail.read too, or a send would show mail that the caller cannot read. A member of a
		// team mailbox needs it in the membership. The credential needs it too, except for an agent in a team
		// mailbox, where the membership alone decides.
		const replyScopes: MailboxMemberScope[] = input.reply_to_message_id ? ["mail.read"] : [];
		const team = input.mailbox_id !== undefined && isTeamMailboxId(input.mailbox_id);
		const missing = replyScopes.filter((scope) => !holdsForResource(call.caller, scope, team));
		if (missing.length > 0) {
			throw new OperationError(
				"forbidden",
				`A reply reads the message that it answers. The credential does not have the scope ${missing.join(", ")}.`,
			);
		}
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.send", replyScopes);
		// The idempotency key is bound to the request, so a reused key with another message is a conflict.
		const { idempotency_key: _key, ...request } = input;
		const requestHash = await sha256Hex(JSON.stringify(request));
		// The members of a team mailbox share its key store. Each key belongs to its caller there, so the
		// key of one member can never return or block the send of a different member.
		const idempotencyKey =
			input.idempotency_key === undefined
				? null
				: record.kind === "team"
					? `${call.caller.id}:${input.idempotency_key}`
					: input.idempotency_key;
		if (idempotencyKey) {
			const earlier = await box.idempotentResult(idempotencyKey, requestHash);
			if (earlier) return accept(earlier);
		}
		const recipients = await resolveRecipients(call, record, [...input.to, ...input.cc, ...input.bcc]);
		checkOutboundPolicy(call, recipients);

		let reply: Awaited<ReturnType<typeof box.getReplyContext>> = null;
		if (input.reply_to_message_id) {
			reply = await box.getReplyContext(input.reply_to_message_id);
			if (!reply) throw new OperationError("not_found", "No message has the id in reply_to_message_id.");
		}
		const limit = recipients.some((r) => r.kind === "external")
			? MAIL_LIMITS.externalMessageBytes
			: MAIL_LIMITS.messageBytes;
		const tooLarge = (bytes: number) =>
			new OperationError(
				"payload_too_large",
				`The message is ${bytes} bytes. The limit is ${limit} bytes${limit === MAIL_LIMITS.externalMessageBytes ? " when a recipient is outside this deployment (Email Service)" : ""}.`,
			);
		// Refuse before anything is decoded, so an oversized request costs no memory.
		const attachmentBytes = input.attachments.reduce(
			(sum, a) => sum + Math.floor((a.content_base64.length * 3) / 4),
			0,
		);
		if (attachmentBytes > limit) throw tooLarge(attachmentBytes);
		const attachments = input.attachments.map((attachment) => {
			try {
				return {
					filename: attachment.filename,
					mimeType: attachment.mime_type,
					content: base64ToBytes(attachment.content_base64),
				};
			} catch {
				throw new OperationError("invalid", `The content of ${attachment.filename} is not valid base64.`);
			}
		});
		const { principal } = call.caller;
		const messageId = newId("msg");
		const now = new Date();
		let raw: string;
		try {
			raw = composeMessage({
				from: { name: record.display_name, address: record.address },
				to: input.to.map(normalizeCase),
				cc: input.cc.map(normalizeCase),
				subject: input.subject ?? (reply ? replySubject(reply.subject) : ""),
				text: input.text,
				html: input.html,
				messageId: `<${messageId.toLowerCase()}@${domainOf(record.address)}>`,
				inReplyTo: reply?.messageIdHeader ?? null,
				references: reply
					? [...reply.references.slice(-19), ...(reply.messageIdHeader ? [reply.messageIdHeader] : [])]
					: undefined,
				date: now,
				attachments,
				headers:
					principal.kind === "agent"
						? [
								["X-Asterra-Agent", "true"],
								["X-Soldock-Agent", "true"],
							]
						: undefined,
			});
		} catch (error) {
			throw new OperationError("invalid", error instanceof Error ? error.message : "The message is not valid.");
		}
		const bytes = new TextEncoder().encode(raw);
		if (bytes.byteLength > limit) throw tooLarge(bytes.byteLength);
		const { contentHash, rawKey } = await storeRaw(call.env, record.id, bytes);
		const parsed = await parseMail(bytes, { authservId: "" });
		const sendInput: SendInput = {
			messageId,
			idempotencyKey,
			requestHash,
			contentHash,
			rawKey,
			size: bytes.byteLength,
			internalDate: now.getTime(),
			parsed,
			bcc: input.bcc.map((address) => ({ name: null, address: normalizeCase(address) })),
			replyThreadId: reply?.threadId ?? null,
			recipients,
			sentBy: { principal_id: principal.id, kind: principal.kind, display_name: principal.display_name },
			// A send that screens a sender in is a decision, so it needs what mail.screen_sender needs: a person
			// with mail.modify in the credential. The check of the membership of a team mailbox is below.
			mayScreen: call.caller.kind === "human" && call.caller.scopes.has("mail.modify"),
		};
		// A send has slow steps: it resolves the recipients, composes the message and writes it to R2. An
		// admin can remove the member in that time. So the handler checks the membership again, just before
		// the mailbox stores the message. This check and the store are not one transaction: a removal
		// between them is too late to stop this send.
		if (record.kind === "team") {
			try {
				const member = await teamMailboxFor(call.env.DIRECTORY, record.id, call.caller.id, [
					"mail.send",
					...replyScopes,
				]);
				sendInput.mayScreen = sendInput.mayScreen === true && member.scopes.includes("mail.modify");
			} catch (error) {
				// No message references this attempt's object.
				await call.env.BLOBS.delete(rawKey);
				throw error;
			}
		}
		// The raw object belongs to this attempt only: its key comes from bytes with a new Message-ID.
		// When the mailbox answers that the key was used, no message references the object, so delete it.
		// After an error the mailbox can still have committed, so the object stays: a dangling reference
		// would lose mail, and an orphan only costs storage until blob GC exists.
		const answer = await box.send(sendInput);
		if ("error" in answer) {
			// No message references this attempt's object.
			await call.env.BLOBS.delete(rawKey);
			return accept(answer);
		}
		const sent = answer;
		if (sent.duplicate) await call.env.BLOBS.delete(rawKey);
		else if (principal.kind === "agent") {
			auditOk(call, record, "mail.send", sent.result.message_id, {
				outboundMode: outboundMode(principal),
				externalRecipients: recipients.filter((recipient) => recipient.kind === "external").length,
			});
		} else auditOk(call, record, "mail.send", sent.result.message_id);
		// Each sender that the send screened in gets the line of a decision. The line never holds the address.
		for (let n = 0; n < sent.screenedIn; n++) auditOk(call, record, "mail.screen_sender", record.id, { code: "in" });
		return sent.result;
	},

	async "mail.suggest_recipients"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.suggest_recipients");
		const recipients = await box.suggestRecipients(input.query ?? "", input.limit ?? DEFAULT_SUGGESTIONS);
		// The addresses tell to whom the agent writes, so a read by an owner or an admin gets a line. The query
		// can hold a private address, so the line names the mailbox only, as for mail.list_threads.
		auditAgentRead(call, record, "mail.suggest_recipients", record.id);
		return {
			recipients: recipients.map((recipient) => ({
				address: recipient.address,
				times_sent: recipient.times_sent,
				last_sent_at: iso(recipient.last_sent_at),
			})),
		};
	},

	async "mail.get_attachment"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "mail.get_attachment");
		const source = await box.getAttachmentSource(input.message_id);
		if (!source) throw new OperationError("not_found", "No message has that id.");
		const meta = source.attachments[input.index];
		if (!meta) throw new OperationError("not_found", "The message has no attachment with that index.");
		if (meta.size > MAIL_LIMITS.attachmentDownloadBytes) {
			throw new OperationError("payload_too_large", "The attachment is too large to return.");
		}
		const object = await call.env.BLOBS.get(source.rawKey);
		if (!object) throw new Error("the raw message is missing from R2");
		const attachment = await readAttachment(await object.arrayBuffer(), input.index);
		if (!attachment) throw new OperationError("not_found", "The message has no attachment with that index.");
		auditAgentRead(call, record, "mail.get_attachment", `${input.message_id}/${input.index}`);
		return {
			filename: attachment.filename,
			mime_type: attachment.mimeType,
			size: attachment.content.byteLength,
			untrusted: source.origin === "external",
			content_base64: bytesToBase64(attachment.content),
		};
	},
};

/** Domains are case-insensitive. Local parts keep their case, as RFC 5321 asks. */
function normalizeCase(address: string): string {
	const at = address.lastIndexOf("@");
	return `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`;
}
