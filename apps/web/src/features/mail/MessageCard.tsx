import type { Address, Label, Message } from "@soldock/contracts";
import { useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { base64ToBytes, saveBytes } from "../../lib/base64.ts";
import { addressName, formatBytes, fullDate, sameAddress, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useToast } from "../../lib/toast.tsx";
import { MessageBody } from "./MessageBody.tsx";
import { mailboxInput, useMailboxId } from "./mailbox.tsx";
import { labelChipName } from "./views.ts";

export type ReplyMode = "reply" | "replyAll" | "forward";

interface MessageCardProps {
	message: Message;
	myAddress: string;
	labelsById: ReadonlyMap<string, Label>;
	defaultExpanded: boolean;
	onReply: (message: Message, mode: ReplyMode) => void;
}

type FullBody =
	| { status: "idle" | "loading" }
	| { status: "ready"; body: Message["body"] }
	| { status: "error"; error: string };

/**
 * The body to show. In a very large thread, mail.get_thread leaves out the bodies of older messages
 * (`body.omitted`). Such a body comes from mail.get_message, but only while `expanded` is true, so a
 * collapsed message causes no call.
 */
function useFullBody(message: Message, expanded: boolean) {
	const [full, setFull] = useState<FullBody>({ status: "idle" });
	const omitted = message.body.omitted;
	const messageId = message.id;
	const mailboxId = useMailboxId();

	const load = useCallback(async () => {
		setFull({ status: "loading" });
		try {
			const result = await api.call("mail.get_message", { ...mailboxInput(mailboxId), message_id: messageId });
			setFull({ status: "ready", body: result.body });
		} catch (caught) {
			setFull({ status: "error", error: errorMessage(caught) });
		}
	}, [mailboxId, messageId]);

	useEffect(() => {
		if (expanded && omitted && full.status === "idle") void load();
	}, [expanded, omitted, full.status, load]);

	const body = !omitted ? message.body : full.status === "ready" ? full.body : null;
	return { body, full, retry: load };
}

export function MessageCard({ message, myAddress, labelsById, defaultExpanded, onReply }: MessageCardProps) {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const { body, full, retry } = useFullBody(message, expanded);
	const bodyId = useId();
	// In a team mailbox, more than one person sends from the address, so the sender is not "me".
	const inTeamMailbox = useMailboxId() !== null;
	const selfAddress = inTeamMailbox ? "" : myAddress;
	// Reply and Forward quote the full body. They wait for a body that mail.get_thread left out.
	const withBody = body ? { ...message, body } : null;
	const spam = message.label_ids.includes("SPAM");
	const sender = message.from;
	const senderName = sender
		? sameAddress(sender.address, selfAddress)
			? "me"
			: addressName(sender)
		: "(unknown sender)";
	const chips = message.label_ids.flatMap((id) => {
		const name = labelChipName(id, labelsById);
		return name ? [{ id, name }] : [];
	});

	return (
		<article className={expanded ? "message message-expanded" : "message"}>
			<h2 className="message-heading">
				<button
					type="button"
					className="message-toggle"
					aria-expanded={expanded}
					aria-controls={bodyId}
					onClick={() => setExpanded((value) => !value)}
				>
					<span className="avatar avatar-small" aria-hidden="true">
						{senderName.slice(0, 1).toUpperCase()}
					</span>
					<span className="message-sender">
						<span className="message-sender-name">{senderName}</span>
						{sender?.name && <span className="message-sender-address">&lt;{sender.address}&gt;</span>}
					</span>
					{!expanded && <span className="message-snippet">{message.snippet}</span>}
					<time className="message-date" dateTime={message.date} title={fullDate(message.date)}>
						{expanded ? fullDate(message.date) : shortDate(message.date)}
					</time>
				</button>
			</h2>
			<div id={bodyId} hidden={!expanded} className="message-content">
				{expanded && (
					<>
						<dl className="message-recipients">
							<RecipientLine term="To" addresses={message.to} myAddress={selfAddress} />
							<RecipientLine term="Cc" addresses={message.cc} myAddress={selfAddress} />
							<RecipientLine term="Bcc" addresses={message.bcc} myAddress={selfAddress} />
							<RecipientLine term="Reply-To" addresses={message.reply_to} myAddress={selfAddress} />
							{inTeamMailbox && message.sent_by && (
								<div className="recipient-line">
									<dt>Sent by:</dt>
									<dd>
										{message.sent_by.display_name}
										{message.sent_by.kind === "agent" ? " (agent)" : ""}
									</dd>
								</div>
							)}
						</dl>
						{chips.length > 0 && (
							<ul className="chips" aria-label="Labels">
								{chips.map((chip) => (
									<li key={chip.id} className="chip">
										{chip.name}
									</li>
								))}
							</ul>
						)}
						{spam && <SpamNotice />}
						{message.untrusted && <ExternalNotice message={message} />}
						{body ? (
							<MessageBody body={body} subject={message.subject} />
						) : full.status === "error" ? (
							<div className="message-body-state" role="alert">
								<p>The message did not load. {full.error}</p>
								<button type="button" className="button button-small" onClick={() => void retry()}>
									Try again
								</button>
							</div>
						) : (
							<div className="message-body-state" aria-live="polite">
								<span className="spinner spinner-small" aria-hidden="true" />
								Loading the message…
							</div>
						)}
						{message.attachments.length > 0 && <Attachments message={message} />}
						{message.origin === "sent" && message.delivery && message.delivery.length > 0 && (
							<Delivery delivery={message.delivery} />
						)}
						<div className="message-actions">
							<button
								type="button"
								className="button button-small"
								onClick={() => withBody && onReply(withBody, "reply")}
								disabled={!withBody}
							>
								<Icon name="reply" size={16} />
								Reply
							</button>
							<button
								type="button"
								className="button button-small"
								onClick={() => withBody && onReply(withBody, "replyAll")}
								disabled={!withBody}
							>
								<Icon name="replyAll" size={16} />
								Reply all
							</button>
							<button
								type="button"
								className="button button-small"
								onClick={() => withBody && onReply(withBody, "forward")}
								disabled={!withBody}
							>
								<Icon name="forward" size={16} />
								Forward
							</button>
						</div>
					</>
				)}
			</div>
		</article>
	);
}

function RecipientLine({
	term,
	addresses,
	myAddress,
}: {
	term: string;
	addresses: readonly Address[];
	myAddress: string;
}) {
	if (addresses.length === 0) return null;
	return (
		<div className="recipient-line">
			<dt>{term}:</dt>
			<dd>
				{addresses
					.map((address) =>
						sameAddress(address.address, myAddress)
							? "me"
							: address.name
								? `${address.name} <${address.address}>`
								: address.address,
					)
					.join(", ")}
			</dd>
		</div>
	);
}

/** A message in Spam can be in a thread with other messages. The notice tells the reader. */
function SpamNotice() {
	return (
		<div className="external-notice spam-notice">
			<Icon name="spam" size={18} />
			<p>
				<strong>This message is in Spam.</strong> Be careful with links, attachments and requests in it.
			</p>
		</div>
	);
}

function ExternalNotice({ message }: { message: Message }) {
	const auth = message.authentication;
	const results: [name: string, value: string][] = [];
	if (auth) {
		if (auth.spf !== null) results.push(["SPF", auth.spf]);
		if (auth.dkim !== null) results.push(["DKIM", auth.dkim]);
		if (auth.dmarc !== null) results.push(["DMARC", auth.dmarc]);
	}
	return (
		<div className="external-notice">
			<Icon name="warning" size={18} />
			<div>
				<p>
					<strong>External sender.</strong> This message came from outside your organization. Be careful with links,
					attachments and requests in it.
				</p>
				{results.length > 0 && (
					<ul className="auth-results" aria-label="Sender authentication">
						{results.map(([name, value]) => (
							<li key={name} className={value.toLowerCase() === "pass" ? "auth-pass" : "auth-fail"}>
								{name}: {value}
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

function Attachments({ message }: { message: Message }) {
	const toast = useToast();
	const mailboxId = useMailboxId();
	const [busy, setBusy] = useState<number | null>(null);

	async function download(index: number) {
		setBusy(index);
		try {
			const file = await api.call("mail.get_attachment", {
				...mailboxInput(mailboxId),
				message_id: message.id,
				index,
			});
			saveBytes(base64ToBytes(file.content_base64), file.filename);
		} catch (error) {
			toast({ message: `The download failed. ${errorMessage(error)}`, tone: "error" });
		} finally {
			setBusy(null);
		}
	}

	return (
		<section className="attachments" aria-label="Attachments">
			<h3 className="attachments-title">
				<Icon name="paperclip" size={16} />
				{message.attachments.length === 1 ? "1 attachment" : `${message.attachments.length} attachments`}
			</h3>
			<ul className="attachment-list">
				{message.attachments.map((attachment) => (
					<li key={attachment.index} className="attachment">
						<span className="attachment-name" title={attachment.filename}>
							{attachment.filename || "(no name)"}
						</span>
						<span className="attachment-meta">
							{attachment.mime_type} · {formatBytes(attachment.size)}
							{attachment.inline ? " · inline" : ""}
						</span>
						<button
							type="button"
							className="button button-small"
							onClick={() => void download(attachment.index)}
							disabled={busy === attachment.index}
							aria-label={`Download ${attachment.filename || "attachment"}`}
						>
							<Icon name="download" size={16} />
							{busy === attachment.index ? "Downloading…" : "Download"}
						</button>
					</li>
				))}
			</ul>
			{message.untrusted && (
				<p className="field-hint">
					These files came from outside your organization. Open them only if you trust the sender.
				</p>
			)}
		</section>
	);
}

const STATUS_NAMES = { queued: "Queued", delivered: "Delivered", sent: "Sent", failed: "Failed" } as const;

function Delivery({ delivery }: { delivery: NonNullable<Message["delivery"]> }) {
	return (
		<section className="delivery" aria-label="Delivery status">
			<h3 className="attachments-title">Delivery</h3>
			<ul className="delivery-list">
				{delivery.map((item) => (
					<li key={item.address} className="delivery-item">
						<span className="delivery-address">{item.address}</span>
						<span className="muted">{item.kind === "local" ? "this organization" : "external"}</span>
						<span className={`status status-${item.status}`}>{STATUS_NAMES[item.status]}</span>
						{item.error && <span className="delivery-error">{item.error}</span>}
					</li>
				))}
			</ul>
		</section>
	);
}
