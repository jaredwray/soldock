import type { ChatRoom, ChatRoomPolicy, OutputOf } from "@asterra/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { saveParts } from "../../lib/base64.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { useSession } from "../auth/session.tsx";
import { roomTitle } from "./model.ts";

export function RoomControls({
	room,
	policy,
	onClose,
	onSaved,
	onDeleted,
}: {
	room: ChatRoom;
	policy: ChatRoomPolicy;
	onClose: () => void;
	onSaved: () => void;
	onDeleted: () => void;
}) {
	const canExport = useSession().whoami.principal.org_role === "owner" && room.role !== null;
	const manage = room.kind !== "dm" && room.role === "owner";
	const canSetRetention = manage || (room.kind === "dm" && canExport);
	// Compare edits with the values at open. A save must preserve concurrent changes to other fields.
	const [initial] = useState(policy);
	const [archived, setArchived] = useState(initial.archived);
	const [posting, setPosting] = useState(initial.posting);
	const [days, setDays] = useState(initial.retention_days?.toString() ?? "");
	const [removing, setRemoving] = useState(false);
	const [saving, setSaving] = useState(false);
	const [exported, setExported] = useState<number | null>(null);
	const [error, setError] = useState("");
	const cancelExport = useRef<AbortController | null>(null);
	const id = useId();
	useEffect(() => () => cancelExport.current?.abort(), []);
	const retention = days === "" ? null : Number(days);
	const changed = archived !== initial.archived || posting !== initial.posting || retention !== initial.retention_days;

	async function save() {
		if (!canSetRetention || !changed || saving) return;
		setSaving(true);
		setError("");
		try {
			await api.call("chat.set_room_policy", {
				room_id: room.id,
				...(archived !== initial.archived && { archived }),
				...(posting !== initial.posting && { posting }),
				...(retention !== initial.retention_days && { retention_days: retention }),
			});
			onSaved();
		} catch (caught) {
			setSaving(false);
			setError(errorMessage(caught));
		}
	}

	async function download() {
		if (cancelExport.current) return;
		const controller = new AbortController();
		cancelExport.current = controller;
		setError("");
		setExported(0);
		try {
			const parts: Blob[] = [];
			let count = 0;
			let after: number | null = null;
			let through: number | undefined;
			do {
				if (controller.signal.aborted) return;
				const page: OutputOf<"chat.export_room"> = await api.call("chat.export_room", {
					room_id: room.id,
					...(after !== null && { after, through }),
				});
				if (controller.signal.aborted) return;
				parts.push(new Blob(page.messages.map((message) => `${JSON.stringify(message)}\n`)));
				count += page.messages.length;
				through = page.through;
				setExported(count);
				after = page.next_after;
			} while (after !== null);
			saveParts(parts, `${room.id}.jsonl`);
		} catch (caught) {
			if (!controller.signal.aborted) setError(errorMessage(caught));
		} finally {
			cancelExport.current = null;
			if (!controller.signal.aborted) setExported(null);
		}
	}

	if (removing) {
		return (
			<ConfirmDialog
				title={`Delete ${roomTitle(room)}?`}
				danger
				confirmLabel="Delete room"
				onClose={() => setRemoving(false)}
				onConfirm={async () => {
					await api.call("chat.delete_room", { room_id: room.id });
					onDeleted();
				}}
			>
				<p>Each member loses access to the room and its messages. This action is permanent.</p>
			</ConfirmDialog>
		);
	}

	return (
		<Dialog title={`Room controls · ${roomTitle(room)}`} onClose={() => !saving && onClose()} className="dialog-small">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<div className="dialog-body chat-form">
					{!manage && room.kind !== "dm" && (
						<p>
							{policy.archived
								? "This room is archived."
								: policy.posting === "owners"
									? "Only room owners can post."
									: "All room members can post."}
						</p>
					)}
					{manage && (
						<>
							<label className="field" htmlFor={`${id}-posting`}>
								<span className="field-label">Who can post</span>
								<select
									id={`${id}-posting`}
									className="input"
									value={posting}
									disabled={saving}
									onChange={(event) => setPosting(event.target.value === "owners" ? "owners" : "members")}
								>
									<option value="members">All room members</option>
									<option value="owners">Room owners only</option>
								</select>
							</label>

							<label>
								<input
									type="checkbox"
									checked={archived}
									disabled={saving}
									onChange={(event) => setArchived(event.target.checked)}
								/>{" "}
								Archive this room
							</label>
							<p className="field-hint">Members can read an archived room. Clear this option to reopen it.</p>
						</>
					)}
					{canSetRetention ? (
						<label className="field" htmlFor={`${id}-days`}>
							<span className="field-label">Keep messages for (days)</span>
							<input
								id={`${id}-days`}
								className="input"
								type="number"
								min={1}
								max={3650}
								step={1}
								placeholder="Forever"
								value={days}
								disabled={saving}
								onChange={(event) => setDays(event.target.value)}
							/>
							<span className="field-hint">
								Older messages are permanently deleted. Leave this empty to keep all messages.
							</span>
						</label>
					) : (
						<p>
							Messages are kept {policy.retention_days === null ? "indefinitely" : `for ${policy.retention_days} days`}.
						</p>
					)}
					{canExport && (
						<div className="field">
							<button
								type="button"
								className="button"
								disabled={saving || exported !== null}
								onClick={() => void download()}
							>
								Export messages
							</button>
							<span className="field-hint" role="status">
								{exported === null ? "Download the messages and replies as JSON Lines." : `Read ${exported} messages…`}
							</span>
						</div>
					)}
					{manage && (
						<button
							type="button"
							className="button button-danger-outline"
							disabled={saving || exported !== null}
							onClick={() => setRemoving(true)}
						>
							Delete room…
						</button>
					)}
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<div className="dialog-actions">
					<button type="button" className="button" onClick={onClose} disabled={saving}>
						Close
					</button>
					{canSetRetention && (
						<button type="submit" className="button button-primary" disabled={saving || !changed || exported !== null}>
							{saving ? "Saving…" : "Save changes"}
						</button>
					)}
				</div>
			</form>
		</Dialog>
	);
}
