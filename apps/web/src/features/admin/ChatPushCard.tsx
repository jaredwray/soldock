import type { ChatPushSettings, InputOf } from "@asterra/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { fullDate } from "../../lib/format.ts";
import { useToast } from "../../lib/toast.tsx";

/**
 * Admin › Chat: Web Push for the organization (`chat.update_push_settings`). An owner or an admin turns on
 * notifications to the devices of the members and sets the contact address. The Worker makes the VAPID key
 * pair and keeps it in the database. No answer contains the private key.
 */
export function ChatPushCard() {
	const toast = useToast();
	const [settings, setSettings] = useState<ChatPushSettings | null>(null);
	const [subject, setSubject] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [rotate, setRotate] = useState(false);
	const subjectId = useId();
	const hintId = useId();
	const keyId = useId();

	const show = useCallback((next: ChatPushSettings) => {
		setSettings(next);
		setSubject(next.subject ?? "");
	}, []);

	const load = useCallback(async () => {
		setError(null);
		try {
			show(await api.call("chat.get_push_settings"));
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [show]);

	useEffect(() => {
		void load();
	}, [load]);

	async function update(change: InputOf<"chat.update_push_settings">, message: string) {
		setBusy(true);
		setError(null);
		try {
			show(await api.call("chat.update_push_settings", change));
			toast({ message });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	function submit(event: FormEvent) {
		event.preventDefault();
		if (!settings) return;
		const trimmed = subject.trim();
		if (!settings.enabled) {
			void update({ enabled: true, subject: trimmed }, "Chat notifications to devices are on.");
		} else if (settings.key_source === "secret") {
			void update({ subject: trimmed }, "The key pair is now in the database.");
		} else {
			void update({ subject: trimmed }, "The contact address is saved.");
		}
	}

	async function rotateKeys() {
		show(await api.call("chat.rotate_push_keys"));
		toast({ message: "The new key pair is in use." });
	}

	const subjectChanged = settings !== null && subject.trim() !== (settings.subject ?? "");
	const submitLabel = !settings?.enabled
		? "Turn on notifications"
		: settings.key_source === "secret"
			? "Store in database"
			: "Save";

	return (
		<section className="panel">
			<div className="panel-heading">
				<p className="panel-intro">Send chat notifications to the browsers and phones of the members.</p>
			</div>
			{settings === null && !error && <p className="panel-card panel-empty">Loading the Web Push settings…</p>}
			{settings === null && error && (
				<div role="alert">
					<p className="form-error">{error}</p>
					<button type="button" className="button" onClick={() => void load()}>
						Try again
					</button>
				</div>
			)}
			{settings && (
				<form className="panel-card panel-form" onSubmit={submit} noValidate>
					<h2 className="panel-title">Device notifications</h2>
					<p className="field-hint">
						{settings.enabled
							? "On. Each member can turn on notifications for a device in Settings › Chat notifications."
							: "Off. Asterra sends no push notifications to the devices of the members."}
					</p>
					{settings.key_source === "secret" && (
						<p className="panel-note">
							The deprecated Worker secrets VAPID_* supply the key pair. Select Store in database to keep the pair here.
							The devices stay subscribed. Then delete the secrets.
						</p>
					)}
					<div className="field">
						<label htmlFor={subjectId} className="field-label">
							Contact address
						</label>
						<input
							id={subjectId}
							className="input"
							type="text"
							autoComplete="off"
							autoCapitalize="none"
							spellCheck={false}
							placeholder="mailto:admin@example.org"
							value={subject}
							onChange={(event) => setSubject(event.target.value)}
							aria-describedby={hintId}
							disabled={busy}
						/>
						<p id={hintId} className="field-hint">
							A mailto: address or an https: URL. The push services of the browsers use it to contact you about a
							problem.
						</p>
					</div>
					{settings.public_key && (
						<div className="field">
							<label htmlFor={keyId} className="field-label">
								Public key
							</label>
							<input id={keyId} className="input input-mono" type="text" value={settings.public_key} readOnly />
							<p className="field-hint">
								{settings.keys_created_at
									? `Made on ${fullDate(settings.keys_created_at)}. The private key stays on the server.`
									: "The private key stays on the server."}
							</p>
						</div>
					)}
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
					<div className="form-actions">
						<button
							type="submit"
							className="button button-primary"
							disabled={
								busy ||
								(settings.enabled && settings.key_source === "settings" && !subjectChanged) ||
								subject.trim() === ""
							}
						>
							{busy ? "Please wait…" : submitLabel}
						</button>
						{settings.enabled && (
							<button
								type="button"
								className="button"
								disabled={busy}
								onClick={() => void update({ enabled: false }, "Chat notifications to devices are off.")}
							>
								Turn off
							</button>
						)}
						{settings.public_key && (
							<button type="button" className="button" disabled={busy} onClick={() => setRotate(true)}>
								Replace keys
							</button>
						)}
					</div>
				</form>
			)}
			{rotate && (
				<ConfirmDialog
					title="Replace the keys?"
					confirmLabel="Replace keys"
					danger
					onClose={() => setRotate(false)}
					onConfirm={rotateKeys}
				>
					<p>
						The current key pair stops at once. Each browser subscribes again with the new key when Asterra opens next.
						Until then, the browser gets no chat notifications.
					</p>
				</ConfirmDialog>
			)}
		</section>
	);
}
