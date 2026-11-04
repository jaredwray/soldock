import { MAIL_LIMITS, type OutputOf } from "@soldock/contracts";
import type { Node } from "prosemirror-model";
import { type ChangeEvent, type FormEvent, useId, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fileToBase64 } from "../../lib/base64.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { formatBytes } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { type Draft, parseAddressList } from "./compose.ts";
import { RichTextEditor } from "./RichTextEditor.tsx";
import { docToHtml, docToText, textToDoc } from "./richText.ts";

export type SendResult = OutputOf<"mail.send">;

interface PendingAttachment {
	id: number;
	filename: string;
	mime_type: string;
	size: number;
	content_base64: string;
}

type AddressField = "to" | "cc" | "bcc";

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
	onClose: () => void;
	onSent: (result: SendResult) => void;
}

export function Composer({ draft, mailDomains, onClose, onSent }: ComposerProps) {
	const [fields, setFields] = useState({ to: draft.to, cc: draft.cc, bcc: draft.bcc });
	const [showCopies, setShowCopies] = useState(draft.cc !== "" || draft.bcc !== "");
	const [subject, setSubject] = useState(draft.subject);
	// The body is a rich-text document. The draft text becomes paragraphs, and its "> " lines a quote.
	const [initialDoc] = useState(() => textToDoc(draft.text));
	const [doc, setDoc] = useState<Node>(initialDoc);
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
	const ids = {
		to: useId(),
		cc: useId(),
		bcc: useId(),
		subject: useId(),
		files: useId(),
		size: useId(),
	};

	const dirty =
		fields.to !== draft.to ||
		fields.cc !== draft.cc ||
		fields.bcc !== draft.bcc ||
		subject !== draft.subject ||
		!doc.eq(initialDoc) ||
		attachments.length > 0;

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
		if (sending || reading) return;
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

	const addressInput = (field: AddressField, label: string, autofocus: boolean) => (
		<div className="compose-row">
			<label htmlFor={ids[field]} className="compose-label">
				{label}
			</label>
			<input
				id={ids[field]}
				className="compose-input"
				type="text"
				inputMode="email"
				autoComplete="off"
				spellCheck={false}
				value={fields[field]}
				onChange={(event) => {
					setFields((current) => ({ ...current, [field]: event.target.value }));
					// The error can name a recipient, so it goes when the recipients change.
					setError(null);
				}}
				aria-invalid={fieldErrors[field] ? true : undefined}
				aria-describedby={fieldErrors[field] ? `${ids[field]}-error` : undefined}
				disabled={sending}
				data-autofocus={autofocus ? true : undefined}
			/>
			{fieldErrors[field] && (
				<p id={`${ids[field]}-error`} className="field-error">
					{fieldErrors[field]}
				</p>
			)}
		</div>
	);

	return (
		<Dialog title={draft.title} onClose={requestClose} className="composer">
			<form className="compose-form" onSubmit={submit} noValidate>
				<div className="compose-fields">
					{addressInput("to", "To", draft.to === "")}
					{showCopies ? (
						<>
							{addressInput("cc", "Cc", false)}
							{addressInput("bcc", "Bcc", false)}
						</>
					) : (
						<button type="button" className="link-button compose-copies" onClick={() => setShowCopies(true)}>
							Add Cc and Bcc
						</button>
					)}
					<div className="compose-row">
						<label htmlFor={ids.subject} className="compose-label">
							Subject
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
					initialDoc={initialDoc}
					onChange={setDoc}
					disabled={sending}
					label="Message"
					placeholder="Write your message"
					autofocus={draft.to !== ""}
				/>
				{attachments.length > 0 && (
					<ul className="compose-attachments" aria-label="Attachments">
						{attachments.map((file) => (
							<li key={file.id} className="compose-attachment">
								<Icon name="paperclip" size={16} />
								<span className="attachment-name" title={file.filename}>
									{file.filename}
								</span>
								<span className="attachment-meta">{formatBytes(file.size)}</span>
								<button
									type="button"
									className="icon-button icon-button-small"
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
					<button type="submit" className="button button-primary" disabled={sending || reading}>
						<Icon name="send" size={16} />
						{sending ? "Sending…" : "Send"}
					</button>
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
						{sending && (
							<>
								<span className="spinner spinner-small" aria-hidden="true" />
								Sending the message…
							</>
						)}
					</span>
					<span className="toolbar-spacer" />
					<button type="button" className="icon-button" aria-label="Discard" title="Discard" onClick={requestClose}>
						<Icon name="trash" />
					</button>
				</div>
			</form>
		</Dialog>
	);
}
