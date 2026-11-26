import type { FeedbackStatus } from "@asterra/contracts";
import { type ClipboardEvent, type DragEvent, type FormEvent, useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fileToBase64 } from "../../lib/base64.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { Icon } from "../../lib/icons.tsx";
import { ASTERRA_VERSION } from "../../lib/version.ts";
import type { Route } from "../../routes.ts";
import { useSession } from "../auth/session.tsx";
import {
	captureFrame,
	isCancelled,
	type Recording,
	requestScreen,
	startRecording,
	stopStream,
	supportsCapture,
	supportsRecording,
} from "./capture.ts";
import {
	ACCEPTED_TYPES,
	attachmentKind,
	blockReason,
	type ClientFacts,
	clock,
	type DraftAttachment,
	emptyDraft,
	type FeedbackDraft,
	pageOf,
	previewIssue,
	submitInput,
	withAttachment,
} from "./model.ts";

interface FeedbackWidgetProps {
	status: FeedbackStatus;
	route: Route;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * The feedback dialog and the recording indicator. The draft stays while the dialog is closed, so the dialog can
 * close during a capture and open again with the same report. The shell loads this chunk when a person opens
 * feedback for the first time.
 */
export function FeedbackWidget({ status, route, open, onOpenChange }: FeedbackWidgetProps) {
	const { whoami } = useSession();
	const [draft, setDraft] = useState<FeedbackDraft>(() => emptyDraft(crypto.randomUUID()));
	const [recording, setRecording] = useState<{ recording: Recording; started: number } | null>(null);
	const [elapsed, setElapsed] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState<{ number: number; url: string } | null>(null);
	// `draftRef` has the draft at this moment, also before React renders it. A decision between two renders reads
	// it: the limit of attachments for each file of one drop, and the removal of an attachment during its upload.
	const draftRef = useRef(draft);
	const alive = useRef(true);
	const activeRecording = useRef<Recording | null>(null);
	const activeStream = useRef<MediaStream | null>(null);

	// The widget goes at a sign-out, and when an admin turns feedback off. The share of the screen stops then, and
	// the local previews of the attachments go.
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			activeRecording.current?.stop();
			if (activeStream.current) stopStream(activeStream.current);
			for (const item of draftRef.current.attachments) URL.revokeObjectURL(item.previewUrl);
		};
	}, []);

	useEffect(() => {
		if (!recording) return;
		const timer = window.setInterval(() => setElapsed((Date.now() - recording.started) / 1000), 250);
		return () => window.clearInterval(timer);
	}, [recording]);

	const facts: ClientFacts = { appVersion: ASTERRA_VERSION, page: pageOf(route), userAgent: navigator.userAgent };
	const full = draft.attachments.length >= status.limits.attachments;

	function updateDraft(update: (current: FeedbackDraft) => FeedbackDraft) {
		draftRef.current = update(draftRef.current);
		setDraft(update);
	}

	function replaceDraft(next: FeedbackDraft) {
		draftRef.current = next;
		setDraft(next);
	}

	function change(patch: Partial<FeedbackDraft>) {
		updateDraft((current) => ({ ...current, ...patch }));
	}

	function patchAttachment(key: string, patch: Partial<DraftAttachment>) {
		updateDraft((current) => ({
			...current,
			attachments: current.attachments.map((item) => (item.key === key ? { ...item, ...patch } : item)),
		}));
	}

	/** Removes a stored file at once, so its public address stops. */
	function deleteStored(id: string) {
		void api.call("feedback.delete_attachment", { attachment_id: id }).catch(() => {});
	}

	/** Adds a file to the draft and uploads it. The server reads the type from the bytes again. */
	async function addFile(file: Blob, name: string) {
		setError(null);
		const kind = attachmentKind(file.type);
		if (!kind) {
			setError("Attach a PNG, JPEG or WebP image, or a WebM or MP4 video.");
			return;
		}
		if (file.size > status.limits.attachment_bytes) {
			setError("An attachment has at most 10 MiB.");
			return;
		}
		const limit = status.limits.attachments;
		const key = crypto.randomUUID();
		const item: DraftAttachment = {
			key,
			kind,
			previewUrl: URL.createObjectURL(file),
			state: "uploading",
			stored: null,
			error: null,
		};
		// The draft gets the attachment before the upload starts, so the files of one drop cannot pass the limit.
		const next = withAttachment(draftRef.current, item, limit);
		if (next === null) {
			URL.revokeObjectURL(item.previewUrl);
			setError(`A report has at most ${limit} attachments.`);
			return;
		}
		updateDraft((current) => withAttachment(current, item, limit) ?? current);
		const inDraft = () => alive.current && draftRef.current.attachments.some((other) => other.key === key);
		try {
			const stored = await api.call("feedback.upload_attachment", {
				name: name.slice(0, 255),
				content_base64: await fileToBase64(file),
			});
			// The person removed the attachment during the upload, or the widget went. The file must not stay public.
			if (inDraft()) patchAttachment(key, { state: "ready", stored });
			else deleteStored(stored.id);
		} catch (caught) {
			if (inDraft()) patchAttachment(key, { state: "failed", error: errorMessage(caught) });
		}
	}

	function removeAttachment(item: DraftAttachment) {
		URL.revokeObjectURL(item.previewUrl);
		updateDraft((current) => ({
			...current,
			attachments: current.attachments.filter((other) => other.key !== item.key),
		}));
		if (item.stored) deleteStored(item.stored.id);
	}

	/** Asks for the screen. Returns null when the person cancelled, on an error, or when the widget went. */
	async function askScreen(): Promise<MediaStream | null> {
		setError(null);
		let stream: MediaStream;
		try {
			stream = await requestScreen();
		} catch (caught) {
			if (alive.current && !isCancelled(caught)) setError(errorMessage(caught));
			return null;
		}
		if (!alive.current) {
			stopStream(stream);
			return null;
		}
		activeStream.current = stream;
		return stream;
	}

	async function takeScreenshot() {
		const stream = await askScreen();
		if (!stream) return;
		try {
			// The dialog closes, so it is not in the screenshot.
			const image = await captureFrame(stream, () => onOpenChange(false));
			if (alive.current) await addFile(image, image.type === "image/png" ? "screenshot.png" : "screenshot.jpg");
		} catch (caught) {
			if (alive.current) setError(errorMessage(caught));
		} finally {
			activeStream.current = null;
			if (alive.current) onOpenChange(true);
		}
	}

	async function record() {
		const stream = await askScreen();
		if (!stream) return;
		let active: Recording;
		try {
			active = startRecording(stream);
		} catch (caught) {
			activeStream.current = null;
			setError(errorMessage(caught));
			return;
		}
		activeRecording.current = active;
		setElapsed(0);
		setRecording({ recording: active, started: Date.now() });
		onOpenChange(false);
		try {
			const video = await active.done;
			if (alive.current) await addFile(video, video.type === "video/mp4" ? "recording.mp4" : "recording.webm");
		} catch (caught) {
			if (alive.current) setError(errorMessage(caught));
		} finally {
			activeRecording.current = null;
			activeStream.current = null;
			if (alive.current) {
				setRecording(null);
				onOpenChange(true);
			}
		}
	}

	function discard() {
		// An attachment that uploads now is not in the new draft, so `addFile` removes its file when the upload ends.
		for (const item of draftRef.current.attachments) {
			URL.revokeObjectURL(item.previewUrl);
			if (item.stored) deleteStored(item.stored.id);
		}
		replaceDraft(emptyDraft(crypto.randomUUID()));
		setError(null);
		setSent(null);
		onOpenChange(false);
	}

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (blockReason(draft) !== null || busy) return;
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("feedback.submit", submitInput(draft, facts));
			for (const item of draft.attachments) URL.revokeObjectURL(item.previewUrl);
			setSent({ number: result.issue_number, url: result.issue_url });
			replaceDraft(emptyDraft(crypto.randomUUID()));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	function close() {
		if (busy) return;
		setSent(null);
		onOpenChange(false);
	}

	return (
		<>
			{recording && (
				<div className="feedback-recording">
					<span className="feedback-recording-dot" aria-hidden="true" />
					{/* A screen reader gets one text that does not change. The clock would speak each second. */}
					<span className="visually-hidden" role="status">
						Asterra records the screen.
					</span>
					<span aria-hidden="true">Recording {clock(elapsed)}</span>
					<button type="button" className="button button-small" onClick={() => recording.recording.stop()}>
						Stop
					</button>
				</div>
			)}
			{open && !recording && (
				<Dialog title="Send feedback" onClose={close} className="dialog-wide feedback-dialog">
					{sent ? (
						<>
							<div className="dialog-body">
								<p>Thank you. Your report is now a public issue on GitHub.</p>
								<p>
									<a href={sent.url} target="_blank" rel="noopener noreferrer">
										Open issue #{sent.number}
									</a>
								</p>
							</div>
							<div className="dialog-actions">
								<button type="button" className="button button-primary" onClick={close} data-autofocus>
									Close
								</button>
							</div>
						</>
					) : (
						<FeedbackForm
							draft={draft}
							status={status}
							reporter={whoami.principal}
							facts={facts}
							busy={busy}
							error={error}
							full={full}
							canCapture={supportsCapture()}
							canRecord={supportsRecording()}
							onChange={change}
							onAddFile={(file, name) => void addFile(file, name)}
							onRemove={removeAttachment}
							onScreenshot={() => void takeScreenshot()}
							onRecord={() => void record()}
							onDiscard={discard}
							onSubmit={submit}
						/>
					)}
				</Dialog>
			)}
		</>
	);
}

interface FeedbackFormProps {
	draft: FeedbackDraft;
	status: FeedbackStatus;
	reporter: { display_name: string; address: string; org_role: "owner" | "admin" | "member" | null };
	facts: ClientFacts;
	busy: boolean;
	error: string | null;
	full: boolean;
	canCapture: boolean;
	canRecord: boolean;
	onChange: (patch: Partial<FeedbackDraft>) => void;
	onAddFile: (file: Blob, name: string) => void;
	onRemove: (item: DraftAttachment) => void;
	onScreenshot: () => void;
	onRecord: () => void;
	onDiscard: () => void;
	onSubmit: (event: FormEvent) => void;
}

function FeedbackForm({
	draft,
	status,
	reporter,
	facts,
	busy,
	error,
	full,
	canCapture,
	canRecord,
	onChange,
	onAddFile,
	onRemove,
	onScreenshot,
	onRecord,
	onDiscard,
	onSubmit,
}: FeedbackFormProps) {
	const ids = { kind: useId(), title: useId(), description: useId(), files: useId(), blocked: useId() };
	const fileInput = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	const issue = previewIssue(draft, reporter, location.host, facts);
	const blocked = blockReason(draft);

	function addFiles(files: Iterable<File>) {
		for (const file of files) onAddFile(file, file.name);
	}

	function onPaste(event: ClipboardEvent) {
		const files = [...event.clipboardData.files].filter((file) => attachmentKind(file.type) !== null);
		if (files.length === 0) return;
		event.preventDefault();
		addFiles(files);
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		setDragging(false);
		addFiles(event.dataTransfer.files);
	}

	return (
		<form
			onSubmit={onSubmit}
			onPaste={onPaste}
			onDragOver={(event) => {
				event.preventDefault();
				setDragging(true);
			}}
			onDragLeave={(event) => {
				// A move to a child of the form is not a leave. Without this check, the highlight flickers.
				if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
				setDragging(false);
			}}
			onDrop={onDrop}
			className={dragging ? "feedback-form feedback-form-drop" : "feedback-form"}
			noValidate
		>
			<div className="dialog-body feedback-body">
				<div className="notice notice-warning" role="note">
					<Icon name="warning" size={16} className="notice-icon" />
					<span>
						This report becomes a public GitHub issue in <strong>{status.repository}</strong>. Each person on the
						internet can read it and open its attachments.
					</span>
				</div>
				<fieldset className="segmented">
					<legend className="field-label">Kind</legend>
					{(
						[
							["bug", "Bug"],
							["idea", "Idea"],
						] as const
					).map(([kind, label]) => (
						<label key={kind} className={draft.kind === kind ? "segment segment-active" : "segment"}>
							<input
								type="radio"
								name={ids.kind}
								value={kind}
								checked={draft.kind === kind}
								onChange={() => onChange({ kind })}
								disabled={busy}
							/>
							{label}
						</label>
					))}
				</fieldset>
				<div className="field">
					<label htmlFor={ids.title} className="field-label">
						Title
					</label>
					<input
						id={ids.title}
						className="input"
						value={draft.title}
						maxLength={status.limits.title_chars}
						onChange={(event) => onChange({ title: event.target.value })}
						placeholder={draft.kind === "bug" ? "The inbox does not load" : "Dark mode for Sheets"}
						disabled={busy}
						data-autofocus
					/>
				</div>
				<div className="field">
					<label htmlFor={ids.description} className="field-label">
						{draft.kind === "bug" ? "What happened, and what did you expect?" : "Describe the idea"}
					</label>
					<textarea
						id={ids.description}
						className="textarea"
						rows={5}
						value={draft.description}
						maxLength={status.limits.description_chars}
						onChange={(event) => onChange({ description: event.target.value })}
						disabled={busy}
					/>
				</div>
				<div className="field">
					<span className="field-label">Attachments</span>
					<div className="feedback-attach-actions">
						{canCapture && (
							<button type="button" className="button button-small" onClick={onScreenshot} disabled={busy || full}>
								<Icon name="screenshot" size={16} />
								Screenshot
							</button>
						)}
						{canRecord && (
							<button type="button" className="button button-small" onClick={onRecord} disabled={busy || full}>
								<Icon name="record" size={16} />
								Record screen
							</button>
						)}
						<button
							type="button"
							className="button button-small"
							onClick={() => fileInput.current?.click()}
							disabled={busy || full}
						>
							<Icon name="paperclip" size={16} />
							Add a file
						</button>
						<input
							id={ids.files}
							ref={fileInput}
							type="file"
							accept={ACCEPTED_TYPES.join(",")}
							multiple
							hidden
							onChange={(event) => {
								addFiles(event.target.files ?? []);
								event.target.value = "";
							}}
						/>
					</div>
					<p className="field-hint">
						You can also paste or drop an image here. A recording stops after {status.limits.recording_seconds} seconds
						and has no sound.
					</p>
					{draft.attachments.length > 0 && (
						<ul className="feedback-attachments">
							{draft.attachments.map((item, index) => (
								<li key={item.key} className="feedback-attachment">
									{item.kind === "image" ? (
										<img src={item.previewUrl} alt={`Attachment ${index + 1}`} />
									) : (
										// biome-ignore lint/a11y/useMediaCaption: a screen recording has no sound to caption.
										<video src={item.previewUrl} controls aria-label={`Recording ${index + 1}`} />
									)}
									<span className="feedback-attachment-state">
										{item.state === "uploading" ? "Uploading…" : item.state === "failed" ? item.error : null}
									</span>
									<button
										type="button"
										className="button button-small"
										onClick={() => onRemove(item)}
										aria-label={`Remove attachment ${index + 1}`}
										disabled={busy}
									>
										Remove
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
				<fieldset className="feedback-identity">
					<legend className="field-label">What the issue shows about you</legend>
					<label className="check-row">
						<input
							type="checkbox"
							className="checkbox"
							checked={draft.includeName}
							onChange={() => onChange({ includeName: !draft.includeName })}
							disabled={busy}
						/>
						<span>My name ({reporter.display_name})</span>
					</label>
					<label className="check-row">
						<input
							type="checkbox"
							className="checkbox"
							checked={draft.includeEmail}
							onChange={() => onChange({ includeEmail: !draft.includeEmail })}
							disabled={busy}
						/>
						<span>My address ({reporter.address})</span>
					</label>
					<label className="check-row">
						<input
							type="checkbox"
							className="checkbox"
							checked={draft.includeBrowser}
							onChange={() => onChange({ includeBrowser: !draft.includeBrowser })}
							disabled={busy}
						/>
						<span>
							My browser
							<span className="check-hint">The issue always has your role, the host of Asterra and the page kind.</span>
						</span>
					</label>
				</fieldset>
				<details className="feedback-preview">
					<summary className="feedback-preview-summary">Preview of the public issue</summary>
					<pre>{`${issue.title}\n\n${issue.body}`}</pre>
				</details>
				<label className="check-row">
					<input
						type="checkbox"
						className="checkbox"
						checked={draft.confirmed}
						onChange={() => onChange({ confirmed: !draft.confirmed })}
						disabled={busy}
					/>
					<span>I examined the text and the attachments. They show no private data.</span>
				</label>
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				{blocked !== null && !busy && (
					<p id={ids.blocked} className="field-hint">
						{blocked}
					</p>
				)}
			</div>
			<div className="dialog-actions">
				<button type="button" className="button link-remove" onClick={onDiscard} disabled={busy}>
					Discard
				</button>
				<button
					type="submit"
					className="button button-primary"
					disabled={busy || blocked !== null}
					aria-describedby={blocked !== null && !busy ? ids.blocked : undefined}
				>
					{busy ? "Sending…" : "Send"}
				</button>
			</div>
		</form>
	);
}
