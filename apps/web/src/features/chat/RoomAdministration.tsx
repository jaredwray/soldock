import type { OutputOf } from "@asterra/contracts";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { plural } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Select } from "../../lib/Select.tsx";
import { principalOption, usePrincipals } from "../../lib/usePrincipals.ts";

type RoomPage = OutputOf<"chat.admin_list_rooms">;
type Summary = RoomPage["rooms"][number];
type Member = OutputOf<"chat.admin_room_members">["members"][number];

export function RoomAdministration({ onClose }: { onClose: () => void }) {
	const [page, setPage] = useState<RoomPage | null>(null);
	const [room, setRoom] = useState<Summary | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const read = useCallback(async (cursor?: string) => {
		setBusy(true);
		setError("");
		try {
			const result = await api.call("chat.admin_list_rooms", cursor ? { cursor } : {});
			setPage((current) => ({
				rooms: cursor && current ? [...current.rooms, ...result.rooms] : result.rooms,
				next_cursor: result.next_cursor,
			}));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}, []);
	useEffect(() => {
		void read();
	}, [read]);

	if (room) {
		return (
			<RoomRecovery
				key={room.id}
				room={room}
				onClose={onClose}
				onBack={() => {
					setRoom(null);
					void read();
				}}
			/>
		);
	}

	return (
		<Dialog title="Room administration" onClose={onClose}>
			<div className="dialog-body chat-dialog-scroll">
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				{busy && (
					<p className="list-state" role="status">
						Loading rooms…
					</p>
				)}
				{page?.rooms.length === 0 && <p className="list-state">No rooms.</p>}
				<ul className="chat-rows">
					{page?.rooms.map((item) => (
						<li key={item.id}>
							<button type="button" className="chat-row chat-row-button" onClick={() => setRoom(item)}>
								<Icon name={item.kind === "dm" ? "chat" : item.kind === "private" ? "lock" : "hash"} />
								<span className="chat-row-text">
									<strong>{item.name ?? item.id}</strong>
									<span className="muted">
										{item.kind} · {plural(item.member_count, "member")}
									</span>
								</span>
							</button>
						</li>
					))}
				</ul>
				{(page?.next_cursor || error) && (
					<button
						type="button"
						className="button"
						disabled={busy}
						onClick={() => void read(page?.next_cursor ?? undefined)}
					>
						{error ? "Try again" : "More rooms"}
					</button>
				)}
			</div>
			<div className="dialog-actions">
				<button type="button" className="button" onClick={onClose}>
					Close
				</button>
			</div>
		</Dialog>
	);
}

function RoomRecovery({ room, onClose, onBack }: { room: Summary; onClose: () => void; onBack: () => void }) {
	const [members, setMembers] = useState<Member[] | null>(null);
	const [principal, setPrincipal] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [cleanup, setCleanup] = useState<Member | null>(null);
	const read = useCallback(async () => {
		const result = await api.call("chat.admin_room_members", { room_id: room.id });
		setMembers(result.members);
	}, [room.id]);
	useEffect(() => {
		read().catch((caught: unknown) => setError(errorMessage(caught)));
	}, [read]);

	async function recover(action: "assign" | "remove", principalId: string) {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await api.call(action === "assign" ? "chat.admin_assign_owner" : "chat.admin_remove_deleted", {
				room_id: room.id,
				principal_id: principalId,
			});
			setNotice(action === "assign" ? "Room owner assigned." : "Deleted account removed.");
			setPrincipal("");
			await read();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	const ownership = members !== null && room.kind !== "dm" && !members.some((member) => member.role === "owner");
	const candidates = members?.filter((member) => !member.deleted) ?? [];
	if (cleanup) {
		const target = cleanup;
		return (
			<ConfirmDialog
				title={`Remove ${target.display_name} from all rooms?`}
				confirmLabel="Remove from all rooms"
				danger
				onClose={() => setCleanup(null)}
				onConfirm={async () => {
					let cursor: string | null = null;
					let removed = 0;
					do {
						const page: OutputOf<"chat.admin_cleanup_principal"> = await api.call("chat.admin_cleanup_principal", {
							principal_id: target.principal_id,
							...(cursor && { cursor }),
						});
						removed += page.removed;
						cursor = page.next_cursor;
					} while (cursor);
					setError("");
					setNotice(`Removed the deleted account from ${plural(removed, "room")}.`);
					await read();
				}}
			>
				<p>This removes the deleted account from each room in the organization.</p>
			</ConfirmDialog>
		);
	}

	return (
		<Dialog title={room.name ?? room.id} onClose={() => !busy && onClose()}>
			<div className="dialog-body chat-dialog-scroll chat-form">
				{members === null && !error && <p role="status">Loading members…</p>}
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				{notice && <p role="status">{notice}</p>}
				<ul className="chat-rows" aria-label="Room members">
					{members?.map((member) => (
						<li className="chat-row" key={member.principal_id}>
							<span className="chat-row-text">
								<strong>{member.display_name}</strong>
								<span className="muted">
									{member.deleted ? "Deleted account" : member.role === "owner" ? "Room owner" : "Member"}
								</span>
							</span>
							{member.deleted && (
								<>
									<button
										type="button"
										className="button button-small"
										disabled={busy}
										aria-label={`Remove deleted account ${member.display_name}`}
										onClick={() => void recover("remove", member.principal_id)}
									>
										Remove
									</button>
									<button
										type="button"
										className="button button-small"
										disabled={busy}
										aria-label={`Remove ${member.display_name} from all rooms`}
										onClick={() => setCleanup(member)}
									>
										All rooms…
									</button>
								</>
							)}
						</li>
					))}
				</ul>
				{ownership && (
					<>
						<p>This room needs an owner.</p>
						{members.length === 0 ? (
							<NewOwner value={principal} onChange={setPrincipal} disabled={busy} />
						) : (
							<Select
								label="New room owner"
								value={principal}
								onChange={setPrincipal}
								disabled={busy}
								placeholder="Choose a room member"
								options={candidates.map((member) => ({ value: member.principal_id, label: member.display_name }))}
							/>
						)}
						<button
							type="button"
							className="button button-primary"
							disabled={busy || !principal}
							onClick={() => void recover("assign", principal)}
						>
							Assign owner
						</button>
					</>
				)}
			</div>
			<div className="dialog-actions">
				<button type="button" className="button" disabled={busy} onClick={onBack}>
					All rooms
				</button>
			</div>
		</Dialog>
	);
}

function NewOwner({
	value,
	onChange,
	disabled,
}: {
	value: string;
	onChange: (value: string) => void;
	disabled: boolean;
}) {
	const principals = usePrincipals();
	return (
		<Select
			label="New room owner"
			placeholder="Choose an active account"
			value={value}
			onChange={onChange}
			disabled={disabled || !principals}
			options={(principals ?? []).filter((person) => !person.archived_at).map(principalOption)}
		/>
	);
}
