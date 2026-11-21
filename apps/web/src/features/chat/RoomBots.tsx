import type { ChatMessage, OutputOf } from "@asterra/contracts";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { useToast } from "../../lib/toast.tsx";
import { ROOM_COMMANDS } from "./roomCommands.ts";

export function CommandHelp({ onClose }: { onClose: () => void }) {
	return (
		<Dialog title="Room commands" onClose={onClose}>
			<dl>
				{ROOM_COMMANDS.map(([command, description]) => (
					<div key={command}>
						<dt>
							<code>{command}</code>
						</dt>
						<dd>{description}</dd>
					</div>
				))}
			</dl>
		</Dialog>
	);
}

export function IncomingHooks({ roomId, onClose }: { roomId: string; onClose: () => void }) {
	const [hooks, setHooks] = useState<OutputOf<"chat.list_incoming_hooks">["hooks"]>([]);
	const [label, setLabel] = useState("");
	const [created, setCreated] = useState<OutputOf<"chat.create_incoming_hook"> | null>(null);
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState("");
	useEffect(() => {
		let active = true;
		api
			.call("chat.list_incoming_hooks", { room_id: roomId })
			.then((result) => {
				if (active) setHooks(result.hooks);
			})
			.catch((caught) => {
				if (active) setError(errorMessage(caught));
			})
			.finally(() => {
				if (active) setBusy(false);
			});
		return () => {
			active = false;
		};
	}, [roomId]);
	async function create() {
		setBusy(true);
		setError("");
		try {
			const result = await api.call("chat.create_incoming_hook", { room_id: roomId, label });
			setCreated(result);
			setHooks((current) => [...current, result.hook]);
			setLabel("");
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}
	async function revoke(id: string) {
		setBusy(true);
		setError("");
		try {
			await api.call("chat.delete_incoming_hook", { room_id: roomId, hook_id: id });
			setHooks((current) => current.filter((hook) => hook.id !== id));
			if (created?.hook.id === id) setCreated(null);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}
	return (
		<Dialog title="Incoming webhooks" onClose={onClose}>
			<ul>
				{hooks.map((hook) => (
					<li key={hook.id}>
						{hook.label}{" "}
						<button className="link-button" type="button" disabled={busy} onClick={() => void revoke(hook.id)}>
							Revoke
						</button>
					</li>
				))}
			</ul>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void create();
				}}
			>
				<label>
					Webhook name{" "}
					<input
						className="input"
						maxLength={64}
						value={label}
						onChange={(event) => setLabel(event.target.value)}
						required
					/>
				</label>
				<button className="button" type="submit" disabled={busy || !label.trim()}>
					Create webhook
				</button>
			</form>
			{created && (
				<div role="status">
					<p>Copy the URL and signing secret. The secret appears once.</p>
					<label>
						Webhook URL
						<input className="input" value={created.url} readOnly />
					</label>
					<label>
						Signing secret
						<input className="input" value={created.secret} readOnly />
					</label>
				</div>
			)}
			{error && <p role="alert">{error}</p>}
		</Dialog>
	);
}

export function CardActions({ message }: { message: ChatMessage }) {
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	const pending = useRef(new Map<string, string>());
	async function click(id: string) {
		if (busy) return;
		const key = pending.current.get(id) ?? crypto.randomUUID();
		pending.current.set(id, key);
		setBusy(true);
		try {
			await api.call("chat.click_button", {
				room_id: message.room_id,
				message_id: message.id,
				action_id: id,
				idempotency_key: key,
			});
			pending.current.delete(id);
			toast({ message: "Your selection is in the thread." });
		} catch (caught) {
			toast({ message: errorMessage(caught), tone: "error" });
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="chat-card-buttons">
			{message.buttons?.map((button) => (
				<button
					key={button.id}
					type="button"
					className="button button-small"
					disabled={busy}
					onClick={() => void click(button.id)}
				>
					{button.label}
				</button>
			))}
		</div>
	);
}
