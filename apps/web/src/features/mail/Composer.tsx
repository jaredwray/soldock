import { MAIL_LIMITS, type OutputOf } from "@asterra/contracts";
import type { Node } from "prosemirror-model";
import { type ChangeEvent, type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fileToBase64 } from "../../lib/base64.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { formatBytes } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Select } from "../../lib/Select.tsx";
import { type Draft, parseAddressList, signatureLines, withSignature } from "./compose.ts";
import { mailboxInput } from "./mailbox.tsx";
import { type FromOption, mailboxKey } from "./mailboxNav.ts";
import { RecipientInput } from "./RecipientInput.tsx";
import { RichTextEditor } from "./RichTextEditor.tsx";
import { docToHtml, docToText, replaceLines, textToDoc } from "./richText.ts";

export type SendResult = OutputOf<"mail.send">;

interface PendingAttachment {
	id: number;
	filename: string;
	mime_type: string;
	size: number;
	content_base64: string;
}

const ADDRESS_FIELDS = ["to", "cc", "bcc"] as const;
type AddressField = (typeof ADDRESS_FIELDS)[number];

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/** Base64 makes a file about 4/3 larger in the composed message. */
function encodedSize(bytes: number): number {
	return Math.ceil(bytes / 3) * 4;
}

const TOO_LARGE = `The message is too large. The limit is ${formatBytes(MAIL_LIMITS.messageBytes)}.`;
const TOO_LONG = `The message text is too long. The limit is ${MAIL_LIMITS.bodyChars.toLocaleString("en-US")} characters.`;

function domainOf(address: string): string {
	return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** The contract refuses control characters, quotes, slashes and backslashes in a file name. */
function safeFilename(name: string): string {
	const cleaned = name.replace(/[\p{Cc}"\\/]/gu, "_").trim();
	return (cleaned || "attachment").slice(0, 255);
}

interface ComposerProps {
	draft: Draft;
	/**
	 * The mail domains of the deployment, from mail.get_profile. A recipient on another domain is
	 * external. Null while the profile loads.
	 */
	mailDomains: readonly string[] | null;
	/** The addresses that the person can send from (`fromOptions`). They include `initialFrom`. */
	fromOptions: readonly FromOption[];
	/**
	 * The mailbox that sends the message at first: the id of a team mailbox, or null for the own mailbox. The
	 * message comes from its name and address, and the sent copy goes into it. A reply comes from the mailbox
	 * of its conversation, so the person cannot change the From of a reply.
	 */
	initialFrom: string | null;
	/** The signature of `initialFrom`. The composer adds it to the draft. */
	signature: string;
	/**
	 * "dialog" (the default) shows the composer in a modal dialog. "inline" shows the same form in the page,
	 * for example under a conversation in the focus view of Reply later.
	 */
	frame?: "dialog" | "inline";
	/** Tells the parent when the message gets text that a close discards, and when it has none again. */
	onDirtyChange?: (dirty: boolean) => void;
	onClose: () => void;
	onSent: (result: SendResult) => void;
}

/** The body of the composer: the editor starts from `doc`. A change of the From can give a new start. */
interface BodySeed {
	doc: Node;
	/** Grows with each new start. It is the key of the editor, so the editor starts again. */
	version: number;
	/** True when the person changed the body before the new start. */
	edited: boolean;
}

export function Composer({
	draft,
	mailDomains,
	fromOptions,
	initialFrom,
	signature,
	frame = "dialog",
	onDirtyChange,
	onClose,
	onSent,
}: ComposerProps) {
	const [fields, setFields] = useState({ to: draft.to, cc: draft.cc, bcc: draft.bcc });
	const [showCopies, setShowCopies] = useState(draft.cc !== "" || draft.bcc !== "");
	const [subject, setSubject] = useState(draft.subject);
	// A reply needs the message that it answers, and only the mailbox of the conversation has it. So a reply
	// shows its From as text, and only a new message and a forward get the list.
	const fromLocked = draft.replyToMessageId !== null;
	const [from, setFrom] = useState(initialFrom);
	const sender = fromOptions.find((option) => option.id === from);
	// The body is a rich-text document. The draft text becomes paragraphs, and its "> " lines a quote.
	const [seed, setSeed] = useState<BodySeed>(() => ({
		doc: textToDoc(withSignature(draft, signature).text),
		version: 0,
		edited: false,
	}));
	const [doc, setDoc] = useState<Node>(seed.doc);
	// A change of the From reads the signature of the new mailbox, and the body can change while it loads. So
	// the change reads the body, the start and the signature in the body from refs.
	const bodyRef = useRef({ doc: seed.doc, seed, signature });
	const signatures = useRef(new Map<string | null, string>([[initialFrom, signature]]));
	const fromChanges = useRef(0);
	// True while a change of the From loads the signature of the new mailbox. Send waits for it, so a message
	// never goes from the new address with the signature of the old one.
	const [loadingSignature, setLoadingSignature] = useState(false);
	// Each send has both forms: HTML for the formatting, and plain text for mail apps without HTML.
	const body = useMemo(() => ({ text: docToText(doc), html: docToHtml(doc) }), [doc]);
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	const [reading, setReading] = useState(false);
	const [sending, setSending] = useState(false);
	const [fieldErrors, setFieldErrors] = useState<Partial<Record<AddressField, string>>>({});
	const [error, setError] = useState<string | null>(null);
	// One key for each composed message: a retry after a network error cannot send it twice.
	const [idempotencyKey] = useState(() => crypto.randomUUID());
	const nextAttachmentId = useRef(1);
	const inlineRef = useRef<HTMLElement>(null);
	const ids = {
		to: useId(),
		cc: useId(),
		bcc: useId(),
		subject: useId(),
		from: useId(),
		files: useId(),
		size: useId(),
	};

	// The dialog gives the focus to its data-autofocus element. The inline frame does the same when it opens.
	// The editor makes its view in a layout effect, so the element exists here.
	useEffect(() => {
		inlineRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
	}, []);

	const dirty =
		fields.to !== draft.to ||
		fields.cc !== draft.cc ||
		fields.bcc !== draft.bcc ||
		subject !== draft.subject ||
		seed.edited ||
		!doc.eq(seed.doc) ||
		attachments.length > 0;

	const onDirtyChangeRef = useRef(onDirtyChange);
	useEffect(() => {
		onDirtyChangeRef.current = onDirtyChange;
	});
	useEffect(() => {
		onDirtyChangeRef.current?.(dirty);
	}, [dirty]);

	const attachmentBytes = attachments.reduce((sum, file) => sum + file.size, 0);
	const textBytes = new Blob([body.text, body.html, subject]).size;
	const estimatedBytes = encodedSize(attachmentBytes) + textBytes;
	const tooLarge = estimatedBytes > MAIL_LIMITS.messageBytes;
	const allRecipients = [fields.to, fields.cc, fields.bcc].flatMap((value) => parseAddressList(value).addresses);
	const localDomains = new Set((mailDomains ?? []).map((domain) => domain.toLowerCase()));
	// Without the profile, the composer cannot tell which recipients are external. The server then decides.
	const externalRecipients =
		mailDomains === null ? [] : allRecipients.filter((address) => !localDomains.has(domainOf(address)));
	const overExternalLimit = estimatedBytes > MAIL_LIMITS.externalMessageBytes;
	const tooLargeForExternal = externalRecipients.length > 0 && overExternalLimit;
	const externalLimit = formatBytes(MAIL_LIMITS.externalMessageBytes);
	const externalNames =
		externalRecipients.length > 3
			? `${externalRecipients.slice(0, 3).join(", ")} and ${externalRecipients.length - 3} more`
			: externalRecipients.join(", ");
	const externalError = `The message is too large for ${externalNames}. Cloudflare Email Service accepts at most ${externalLimit} for mail to an address outside your organization. Make the message smaller, or remove those recipients.`;
	const showExternalHint = externalRecipients.length > 0 || (mailDomains === null && overExternalLimit);

	function changeBody(next: Node) {
		bodyRef.current.doc = next;
		setDoc(next);
	}

	/**
	 * A new From. The signature of the old mailbox in the body becomes the signature of the new one. A body
	 * that the person did not change starts again with the new signature. When the person changed the lines of
	 * the signature, the body stays as it is.
	 */
	async function changeFrom(next: string | null) {
		setFrom(next);
		setError(null);
		const change = ++fromChanges.current;
		let nextSignature = signatures.current.get(next);
		if (nextSignature === undefined) {
			setLoadingSignature(true);
			try {
				nextSignature = (await api.call("mail.get_mailbox_settings", mailboxInput(next))).signature;
				signatures.current.set(next, nextSignature);
			} catch {
				// A membership without mail.read cannot read the signature. The body then gets none.
				nextSignature = "";
			}
		}
		// A newer change of the From decides the body.
		if (change !== fromChanges.current) return;
		setLoadingSignature(false);
		const current = bodyRef.current;
		if (nextSignature === current.signature) return;
		const untouched = !current.seed.edited && current.doc.eq(current.seed.doc);
		const swapped = untouched
			? textToDoc(withSignature(draft, nextSignature).text)
			: replaceLines(current.doc, signatureLines(current.signature), signatureLines(nextSignature));
		if (!swapped) return;
		const nextSeed = { doc: swapped, version: current.seed.version + 1, edited: !untouched };
		bodyRef.current = { doc: swapped, seed: nextSeed, signature: nextSignature };
		setSeed(nextSeed);
		setDoc(swapped);
	}

	function requestClose() {
		if (sending) return;
		if (dirty && !window.confirm("Discard this message?")) return;
		onClose();
	}

	async function addFiles(event: ChangeEvent<HTMLInputElement>) {
		const files = [...(event.target.files ?? [])];
		event.target.value = "";
		if (files.length === 0) return;
		if (attachments.length + files.length > MAIL_LIMITS.attachments) {
			setError(`A message can have at most ${MAIL_LIMITS.attachments} attachments.`);
			return;
		}
		// Refuse files that make the message too large before the browser reads them into memory.
		const addedBytes = files.reduce((sum, file) => sum + file.size, 0);
		if (
			files.some((file) => file.size > MAIL_LIMITS.messageBytes) ||
			encodedSize(attachmentBytes + addedBytes) + textBytes > MAIL_LIMITS.messageBytes
		) {
			setError(TOO_LARGE);
			return;
		}
		setReading(true);
		setError(null);
		try {
			const added: PendingAttachment[] = [];
			for (const file of files) {
				added.push({
					id: nextAttachmentId.current++,
					filename: safeFilename(file.name),
					mime_type: MIME_PATTERN.test(file.type) ? file.type : "application/octet-stream",
					size: file.size,
					content_base64: await fileToBase64(file),
				});
			}
			setAttachments((current) => [...current, ...added]);
		} catch {
			setError("A file could not be read. Try again.");
		} finally {
			setReading(false);
		}
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (sending || reading || loadingSignature) return;
		const parsed = {
			to: parseAddressList(fields.to),
			cc: parseAddressList(fields.cc),
			bcc: parseAddressList(fields.bcc),
		};
		const errors: Partial<Record<AddressField, string>> = {};
		for (const field of ["to", "cc", "bcc"] as const) {
			const invalid = parsed[field].invalid;
			if (invalid.length > 0) errors[field] = `Not a valid address: ${invalid.join(", ")}`;
		}
		setFieldErrors(errors);
		if (Object.keys(errors).length > 0) {
			setError("Correct the addresses, then send again.");
			return;
		}
		const count = parsed.to.addresses.length + parsed.cc.addresses.length + parsed.bcc.addresses.length;
		if (count === 0) {
			setFieldErrors({ to: "Add at least one recipient." });
			setError("Add at least one recipient.");
			return;
		}
		if (count > MAIL_LIMITS.recipients) {
			setError(`A message can have at most ${MAIL_LIMITS.recipients} recipients in To, Cc and Bcc together.`);
			return;
		}
		if (body.text.length > MAIL_LIMITS.bodyChars || body.html.length > MAIL_LIMITS.bodyChars) {
			setError(TOO_LONG);
			return;
		}
		if (tooLarge) {
			setError(TOO_LARGE);
			return;
		}
		if (tooLargeForExternal) {
			setError(externalError);
			return;
		}
		setSending(true);
		setError(null);
		try {
			const result = await api.call("mail.send", {
				...mailboxInput(from),
				to: parsed.to.addresses,
				cc: parsed.cc.addresses,
				bcc: parsed.bcc.addresses,
				subject,
				text: body.text,
				html: body.html,
				attachments: attachments.map(({ filename, mime_type, content_base64 }) => ({
					filename,
					mime_type,
					content_base64,
				})),
				idempotency_key: idempotencyKey,
				...(draft.replyToMessageId ? { reply_to_message_id: draft.replyToMessageId } : {}),
			});
			onSent(result);
		} catch (caught) {
			setError(errorMessage(caught));
			setSending(false);
		}
	}

	const addressInput = (field: AddressField, label: string, autofocus: boolean, extra?: ReactNode) => (
		<div className={extra ? "compose-row compose-row-extra" : "compose-row"}>
			<label htmlFor={ids[field]} className="compose-label">
				{label}
			</label>
			<RecipientInput
				id={ids[field]}
				value={fields[field]}
				onChange={(value) => {
					setFields((current) => ({ ...current, [field]: value }));
					// The error can name a recipient, so it goes when the recipients change.
					setError(null);
				}}
				otherAddresses={ADDRESS_FIELDS.filter((other) => other !== field).flatMap(
					(other) => parseAddressList(fields[other]).addresses,
				)}
				invalid={Boolean(fieldErrors[field])}
				describedBy={fieldErrors[field] ? `${ids[field]}-error` : undefined}
				disabled={sending}
				autofocus={autofocus}
			/>
			{extra}
			{fieldErrors[field] && (
				<p id={`${ids[field]}-error`} className="field-error">
					{fieldErrors[field]}
				</p>
			)}
		</div>
	);

	const form = (
		<form className="compose-form" onSubmit={submit} noValidate>
			<div className="compose-fields">
				{fromLocked ? (
					sender && (
						<div className="compose-row">
							<span className="compose-label">From:</span>
							<span className="compose-from">
								{sender.display_name} &lt;{sender.address}&gt;
							</span>
						</div>
					)
				) : (
					<div className="compose-row">
						<label htmlFor={ids.from} className="compose-label">
							From:
						</label>
						<Select
							id={ids.from}
							className="compose-select"
							value={mailboxKey(from)}
							options={fromOptions.map((option) => ({
								value: mailboxKey(option.id),
								label: option.display_name,
								description: `<${option.address}>`,
							}))}
							onChange={(key) =>
								void changeFrom(fromOptions.find((option) => mailboxKey(option.id) === key)?.id ?? null)
							}
							disabled={sending}
						/>
					</div>
				)}
				{addressInput(
					"to",
					"To:",
					draft.to === "",
					showCopies ? undefined : (
						<button type="button" className="compose-copies" onClick={() => setShowCopies(true)}>
							Add Cc and Bcc
						</button>
					),
				)}
				{showCopies && (
					<>
						{addressInput("cc", "Cc:", false)}
						{addressInput("bcc", "Bcc:", false)}
					</>
				)}
				<div className="compose-row">
					<label htmlFor={ids.subject} className="compose-label">
						Subject:
					</label>
					<input
						id={ids.subject}
						className="compose-input"
						type="text"
						maxLength={MAIL_LIMITS.subjectChars}
						value={subject}
						onChange={(event) => setSubject(event.target.value)}
						disabled={sending}
					/>
				</div>
			</div>
			<RichTextEditor
				key={seed.version}
				initialDoc={seed.doc}
				onChange={changeBody}
				disabled={sending}
				label="Message"
				placeholder="Write your message"
				// A new start after a change of the From keeps the focus on the From.
				autofocus={seed.version === 0 && draft.to !== ""}
			/>
			{attachments.length > 0 && (
				<ul className="file-cards compose-attachments" aria-label="Attachments">
					{attachments.map((file) => (
						<li key={file.id} className="file-card">
							<span className="file-card-icon">
								<Icon name={file.mime_type.startsWith("image/") ? "image" : "file"} size={20} />
							</span>
							<span className="file-card-text">
								<span className="file-card-name" title={file.filename}>
									{file.filename}
								</span>
								<span className="file-card-meta">{formatBytes(file.size)}</span>
							</span>
							<button
								type="button"
								className="icon-button icon-button-small file-card-action"
								aria-label={`Remove ${file.filename}`}
								title="Remove"
								onClick={() => {
									setAttachments((current) => current.filter((item) => item.id !== file.id));
									setError(null);
								}}
								disabled={sending}
							>
								<Icon name="close" size={16} />
							</button>
						</li>
					))}
				</ul>
			)}
			<p
				id={ids.size}
				className={tooLarge || tooLargeForExternal ? "compose-size field-error" : "compose-size field-hint"}
			>
				{attachments.length > 0
					? `${attachments.length} of ${MAIL_LIMITS.attachments} files, ${formatBytes(attachmentBytes)}. The message is about ${formatBytes(estimatedBytes)} of ${formatBytes(MAIL_LIMITS.messageBytes)}.`
					: `Up to ${MAIL_LIMITS.attachments} files. A message can be at most ${formatBytes(MAIL_LIMITS.messageBytes)}.`}
				{showExternalHint && ` Mail to addresses outside your organization can be at most ${externalLimit}.`}
			</p>
			<div aria-live="assertive">
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
			</div>
			<div className="compose-actions">
				<input
					id={ids.files}
					type="file"
					multiple
					className="visually-hidden"
					onChange={(event) => void addFiles(event)}
					disabled={sending || reading}
					aria-describedby={ids.size}
				/>
				<label htmlFor={ids.files} className={sending || reading ? "button button-disabled" : "button"}>
					<Icon name="paperclip" size={16} />
					{reading ? "Reading files…" : "Attach files"}
				</label>
				<span className="compose-status" aria-live="polite">
					{(sending || loadingSignature) && (
						<>
							<span className="spinner spinner-small" aria-hidden="true" />
							{sending ? "Sending the message…" : "Loading the signature…"}
						</>
					)}
				</span>
				<span className="toolbar-spacer" />
				<button type="button" className="icon-button" aria-label="Discard" title="Discard" onClick={requestClose}>
					<Icon name="trash" />
				</button>
				<button type="submit" className="button button-primary" disabled={sending || reading || loadingSignature}>
					<Icon name="send" size={16} />
					{sending ? "Sending…" : "Send"}
				</button>
			</div>
		</form>
	);

	if (frame === "dialog") {
		return (
			<Dialog title={draft.title} onClose={requestClose} className="composer">
				{form}
			</Dialog>
		);
	}
	// Escape closes the inline composer as it closes the dialog. A menu in the form, for example the
	// address suggestions, handles its own Escape first.
	return (
		<section
			ref={inlineRef}
			className="compose-inline"
			aria-label={draft.title}
			onKeyDown={(event) => {
				if (event.key !== "Escape" || event.defaultPrevented) return;
				// The link dialog of the editor is a child in React, so its keys come here. Its Escape closes only it.
				if (event.target instanceof Element && event.target.closest("dialog")) return;
				event.preventDefault();
				requestClose();
			}}
		>
			{form}
		</section>
	);
}
