import type { Address, Label, Message } from "@asterra/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { base64ToBytes, saveBytes } from "../../lib/base64.ts";
import { addressName, formatBytes, fullDate, initials, sameAddress, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useToast } from "../../lib/toast.tsx";
import { isAgentMailbox } from "../../routes.ts";
import { AUTO_MARK_TEXT, AUTO_MARK_TITLE } from "./autoLabels.ts";
import { MessageBody } from "./MessageBody.tsx";
import { mailboxInput, useMailboxId, useMailboxRights } from "./mailbox.tsx";
import { labelChipName } from "./views.ts";

export type ReplyMode = "reply" | "replyAll" | "forward";

interface MessageCardProps {
	message: Message;
	myAddress: string;
	labelsById: ReadonlyMap<string, Label>;
	defaultExpanded: boolean;
	/** The heading of the message: h2 in a thread, h3 under the subject of the conversation in Focus. */
	heading?: "h2" | "h3";
	onReply: (message: Message, mode: ReplyMode) => void;
	/**
	 * Gets the message with its full body when that body is there. A parent that starts a reply itself, such as
	 * the conversation in Focus for a key, uses it, so the reply never quotes a body that the server left out.
	 */
	onFullBody?: (message: Message) => void;
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

export function MessageCard({
	message,
	myAddress,
	labelsById,
	defaultExpanded,
	heading: Heading = "h2",
	onReply,
	onFullBody,
}: MessageCardProps) {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const { body, full, retry } = useFullBody(message, expanded);
	const onFullBodyRef = useRef(onFullBody);
	useEffect(() => {
		onFullBodyRef.current = onFullBody;
	});
	useEffect(() => {
		if (body) onFullBodyRef.current?.({ ...message, body });
	}, [message, body]);
	const bodyId = useId();
	// In a team mailbox, more than one person sends from the address, so the sender is not "me". In the
	// mailbox of an agent, the sender is the agent, not the person who reads.
	const mailboxId = useMailboxId();
	const canSend = useMailboxRights().send;
	const inTeamMailbox = mailboxId !== null && !isAgentMailbox(mailboxId);
	const selfAddress = mailboxId === null ? myAddress : "";
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
		return name ? [{ id, name, auto: message.auto_label_ids.includes(id) }] : [];
	});

	const date = (
		<time className="message-date" dateTime={message.date} title={fullDate(message.date)}>
			{expanded ? fullDate(message.date) : shortDate(message.date)}
		</time>
	);

	return (
		<article className={expanded ? "message message-expanded" : "message"}>
			{/* In an open message, the address, the copy button and the date are outside the toggle, because a button
			    cannot hold a button. The toggle keeps its place in the tree, so React keeps it, and its focus, when the
			    message opens. */}
			<div className="message-header">
				<div className="message-from">
					<Heading className="message-heading">
						<button
							type="button"
							className="message-toggle"
							aria-expanded={expanded}
							aria-controls={bodyId}
							onClick={() => setExpanded((value) => !value)}
						>
							<span className="message-avatar" aria-hidden="true">
								<span className="avatar message-avatar-mark">{sender ? initials(addressName(sender)) : "?"}</span>
							</span>
							<span className="message-summary">
								<span className="message-sender">
									<span className="message-sender-name">{senderName}</span>
								</span>
								{!expanded && <span className="message-snippet">{message.snippet}</span>}
							</span>
							{!expanded && message.attachments.length > 0 && (
								<span className="message-mark">
									<Icon name="paperclip" size={16} />
									<span className="visually-hidden">Has attachments, </span>
								</span>
							)}
							{!expanded && date}
						</button>
					</Heading>
					{expanded && sender && (
						<span className="message-sender-detail">
							{sender.name && <span className="message-sender-address">&lt;{sender.address}&gt;</span>}
							<CopyAddressButton address={sender.address} />
						</span>
					)}
				</div>
				{expanded && date}
			</div>
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
									<li
										key={chip.id}
										className={chip.auto ? "chip mail-chip chip-auto" : "chip mail-chip"}
										title={chip.auto ? AUTO_MARK_TITLE : undefined}
									>
										{chip.auto && <Icon name="sparks" size={12} className="auto-mark" />}
										{chip.name}
										{chip.auto && <span className="visually-hidden">{AUTO_MARK_TEXT}</span>}
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
						{canSend && (
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
						)}
					</>
				)}
			</div>
		</article>
	);
}

/** Puts the address of the sender on the clipboard. It shows when the pointer is on the header of the message. */
function CopyAddressButton({ address }: { address: string }) {
	const toast = useToast();
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 2000);
		return () => window.clearTimeout(timer);
	}, [copied]);

	async function copy() {
		try {
			await navigator.clipboard.writeText(address);
			setCopied(true);
		} catch {
			toast({ message: "The browser did not permit a copy to the clipboard.", tone: "error" });
		}
	}

	return (
		<button
			type="button"
			className="icon-button message-copy-address"
			title={copied ? "Copied" : "Copy the address"}
			onClick={() => void copy()}
		>
			<Icon name={copied ? "check" : "copy"} size={16} />
			<span className="visually-hidden" aria-live="polite">
				{copied ? `Copied ${address}` : `Copy the address ${address}`}
			</span>
		</button>
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
			<h3 className="message-section-title">
				{message.attachments.length === 1 ? "1 attachment" : `${message.attachments.length} attachments`}
			</h3>
			<ul className="file-cards">
				{message.attachments.map((attachment) => (
					<li key={attachment.index} className="file-card">
						<span className="file-card-icon">
							<Icon name={attachment.mime_type.startsWith("image/") ? "image" : "file"} size={20} />
						</span>
						<span className="file-card-text">
							<span className="file-card-name" title={attachment.filename}>
								{attachment.filename || "(no name)"}
							</span>
							<span className="file-card-meta">
								{formatBytes(attachment.size)} · {attachment.mime_type}
								{attachment.inline ? " · inline" : ""}
							</span>
						</span>
						<button
							type="button"
							className="icon-button icon-button-small file-card-action"
							onClick={() => void download(attachment.index)}
							disabled={busy === attachment.index}
							aria-label={
								busy === attachment.index
									? `Downloading ${attachment.filename || "attachment"}…`
									: `Download ${attachment.filename || "attachment"}`
							}
							title={busy === attachment.index ? "Downloading…" : "Download"}
						>
							{busy === attachment.index ? (
								<span className="spinner spinner-small" aria-hidden="true" />
							) : (
								<Icon name="download" size={18} />
							)}
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
			<h3 className="message-section-title">Delivery</h3>
			<ul className="delivery-list">
				{delivery.map((item) => (
					<li key={item.address} className="delivery-item">
						<span className={`delivery-chip delivery-${item.status}`}>
							<span className="delivery-dot" aria-hidden="true" />
							<span className="delivery-address">{item.address}</span>
							<span className="delivery-kind">{item.kind === "local" ? "this organization" : "external"}</span>
							<span className="delivery-status">{STATUS_NAMES[item.status]}</span>
						</span>
						{item.error && <span className="delivery-error">{item.error}</span>}
					</li>
				))}
			</ul>
		</section>
	);
}
