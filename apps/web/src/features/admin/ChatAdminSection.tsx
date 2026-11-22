import {
	CHAT_LIMITS,
	type ChatAdminRoom,
	type ChatCustomEmoji,
	type ChatSlashCommand,
	type Principal,
} from "@asterra/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { shortDate } from "../../lib/format.ts";
import { useToast } from "../../lib/toast.tsx";
import { useSession } from "../auth/session.tsx";

async function fileToBase64(file: File): Promise<string> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export function ChatAdminSection({ principals }: { principals: readonly Principal[] }) {
	const self = useSession().whoami.principal;
	const isOrgOwner = self.org_role === "owner";
	const toast = useToast();

	// Rooms tab
	const [filter, setFilter] = useState<"all" | "ownerless" | "archived">("all");
	const [query, setQuery] = useState("");
	const [rooms, setRooms] = useState<ChatAdminRoom[]>([]);
	const [roomsLoading, setRoomsLoading] = useState(true);
	const [assignRoomId, setAssignRoomId] = useState<string | null>(null);
	const [assignPrincipalId, setAssignPrincipalId] = useState("");
	const [deletePreview, setDeletePreview] = useState<{
		roomId: string;
		message_count: number;
		member_count: number;
	} | null>(null);

	// Deleted principal cleanup
	const [cleanupPrincipalId, setCleanupPrincipalId] = useState("");
	const cleanupId = useId();

	// Custom emoji
	const [emojiList, setEmojiList] = useState<ChatCustomEmoji[]>([]);
	const [emojiName, setEmojiName] = useState("");
	const [emojiFile, setEmojiFile] = useState<File | null>(null);
	const emojiNameId = useId();
	const emojiFileId = useId();

	// Slash commands
	const [commands, setCommands] = useState<ChatSlashCommand[]>([]);
	const [cmdName, setCmdName] = useState("");
	const [cmdDesc, setCmdDesc] = useState("");
	const [cmdHint, setCmdHint] = useState("");
	const [cmdOp, setCmdOp] = useState("chat.post_message");
	const [cmdTemplate, setCmdTemplate] = useState('{"room_id":"{{room_id}}","text":"{{text}}"}');

	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const activePrincipals = principals.filter((p) => !p.archived_at);

	const loadRooms = useCallback(async () => {
		setRoomsLoading(true);
		setError(null);
		try {
			const res = await api.call("chat.admin_list_rooms", {
				archived: filter === "archived" ? "archived" : "all",
				...(filter === "ownerless" ? { ownerless: "true" as const } : {}),
				...(query.trim() ? { query: query.trim() } : {}),
			});
			setRooms(res.rooms);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setRoomsLoading(false);
		}
	}, [filter, query]);

	const loadMeta = useCallback(async () => {
		try {
			const [eRes, cRes] = await Promise.all([
				api.call("chat.list_custom_emoji"),
				api.call("chat.list_slash_commands"),
			]);
			setEmojiList(eRes.emoji);
			setCommands(cRes.commands);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, []);

	useEffect(() => {
		void loadRooms();
	}, [loadRooms]);

	useEffect(() => {
		void loadMeta();
	}, [loadMeta]);

	async function assignOwner(roomId: string) {
		if (!assignPrincipalId) return;
		setBusy(true);
		setError(null);
		try {
			await api.call("chat.admin_assign_owner", { room_id: roomId, principal_id: assignPrincipalId });
			setAssignRoomId(null);
			setAssignPrincipalId("");
			toast({ message: "Room owner assigned." });
			await loadRooms();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function toggleArchive(room: ChatAdminRoom) {
		setBusy(true);
		setError(null);
		try {
			if (room.archived_at === null) {
				await api.call("chat.archive_room", { room_id: room.id });
				toast({ message: "Room archived." });
			} else {
				await api.call("chat.unarchive_room", { room_id: room.id });
				toast({ message: "Room unarchived." });
			}
			await loadRooms();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function runDelete(roomId: string, dryRun: boolean) {
		setBusy(true);
		setError(null);
		try {
			const res = await api.call("chat.delete_room", { room_id: roomId, dry_run: dryRun });
			if (dryRun) {
				setDeletePreview({ roomId, message_count: res.message_count, member_count: res.member_count });
			} else {
				setDeletePreview(null);
				toast({ message: "Room permanently deleted." });
				await loadRooms();
			}
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function exportRoom(roomId: string) {
		setBusy(true);
		setError(null);
		try {
			const messages: unknown[] = [];
			let afterSeq = 0;
			let meta: Record<string, unknown> | null = null;
			while (true) {
				const page = await api.call("chat.export_room", { room_id: roomId, after_seq: afterSeq });
				if (!meta) meta = { room: page.room, members: page.members, pins: page.pins, exported_at: page.exported_at };
				messages.push(...page.messages);
				if (page.next_after_seq === null) break;
				if (page.next_after_seq <= afterSeq) {
					throw new Error("Export pagination did not advance.");
				}
				afterSeq = page.next_after_seq;
			}
			const blob = new Blob([JSON.stringify({ ...meta, messages }, null, 2)], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `chat-export-${roomId}.json`;
			link.click();
			URL.revokeObjectURL(url);
			toast({ message: "Room export downloaded." });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function cleanupDeletedPrincipal(event: FormEvent) {
		event.preventDefault();
		if (!cleanupPrincipalId.trim()) return;
		setBusy(true);
		setError(null);
		try {
			const res = await api.call("chat.admin_remove_deleted_principal", {
				principal_id: cleanupPrincipalId.trim(),
			});
			toast({ message: `Removed from ${res.rooms_cleaned} rooms.` });
			setCleanupPrincipalId("");
			await loadRooms();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function uploadEmoji(event: FormEvent) {
		event.preventDefault();
		if (!emojiName.trim() || !emojiFile) {
			setError("Enter a name and choose a PNG, JPEG, GIF, or WebP file.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const content_base64 = await fileToBase64(emojiFile);
			await api.call("chat.create_custom_emoji", {
				name: emojiName.trim().toLowerCase(),
				content_base64,
			});
			setEmojiName("");
			setEmojiFile(null);
			toast({ message: "Custom emoji added." });
			await loadMeta();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function deleteEmoji(name: string) {
		setBusy(true);
		setError(null);
		try {
			await api.call("chat.delete_custom_emoji", { name });
			toast({ message: `Deleted :${name}:.` });
			await loadMeta();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function createCommand(event: FormEvent) {
		event.preventDefault();
		let template: Record<string, unknown>;
		try {
			template = JSON.parse(cmdTemplate) as Record<string, unknown>;
			if (typeof template !== "object" || template === null || Array.isArray(template)) {
				throw new Error("Input template must be a JSON object.");
			}
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Invalid JSON template.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.call("chat.create_slash_command", {
				command: cmdName.trim().toLowerCase(),
				description: cmdDesc.trim(),
				...(cmdHint.trim() ? { usage_hint: cmdHint.trim() } : {}),
				operation: cmdOp.trim(),
				input_template: template,
			});
			setCmdName("");
			setCmdDesc("");
			setCmdHint("");
			toast({ message: "Slash command created." });
			await loadMeta();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function deleteCommand(id: string) {
		setBusy(true);
		setError(null);
		try {
			await api.call("chat.delete_slash_command", { command_id: id });
			toast({ message: "Slash command deleted." });
			await loadMeta();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="admin-chat">
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}

			<section className="panel-card">
				<h2 className="panel-title">Chat rooms</h2>
				<div className="chat-subview-bar">
					{(["all", "ownerless", "archived"] as const).map((f) => (
						<button
							key={f}
							type="button"
							className={filter === f ? "chip chip-active" : "chip"}
							onClick={() => setFilter(f)}
						>
							{f === "all" ? "All" : f === "ownerless" ? "Ownerless" : "Archived"}
						</button>
					))}
					<input
						type="search"
						className="input"
						placeholder="Filter rooms by name…"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</div>
				{roomsLoading ? (
					<p className="field-hint">Loading rooms…</p>
				) : rooms.length === 0 ? (
					<p className="field-hint">No rooms match this filter.</p>
				) : (
					<ul className="chat-admin-list">
						{rooms.map((room) => (
							<li key={room.id} className="chat-admin-row">
								<div className="chat-admin-meta">
									<strong>{room.name ?? room.id}</strong> <span className="kind">{room.kind}</span>
									{room.archived_at && <span className="kind">archived</span>}
									{room.owner_count === 0 && <span className="kind">ownerless</span>}
									<p className="muted">
										{room.member_count} members · {room.owner_count} owners · created {shortDate(room.created_at)}
									</p>
								</div>
								<div className="chat-feed-actions">
									<button
										type="button"
										className="button button-small"
										disabled={busy}
										onClick={() => setAssignRoomId(assignRoomId === room.id ? null : room.id)}
									>
										Assign owner
									</button>
									<button
										type="button"
										className="button button-small"
										disabled={busy}
										onClick={() => void toggleArchive(room)}
									>
										{room.archived_at ? "Unarchive" : "Archive"}
									</button>
									{isOrgOwner && (
										<button
											type="button"
											className="button button-small"
											disabled={busy}
											onClick={() => void exportRoom(room.id)}
										>
											Export
										</button>
									)}
									<button
										type="button"
										className="button button-small button-danger-outline"
										disabled={busy}
										onClick={() => void runDelete(room.id, true)}
									>
										Delete
									</button>
								</div>
								{assignRoomId === room.id && (
									<div className="chat-inline-row">
										<select
											className="input"
											aria-label="New owner"
											value={assignPrincipalId}
											onChange={(event) => setAssignPrincipalId(event.target.value)}
										>
											<option value="">Choose person or agent…</option>
											{activePrincipals.map((p) => (
												<option key={p.id} value={p.id}>
													{p.display_name} ({p.address})
												</option>
											))}
										</select>
										<button
											type="button"
											className="button button-small button-primary"
											disabled={busy || !assignPrincipalId}
											onClick={() => void assignOwner(room.id)}
										>
											Save owner
										</button>
									</div>
								)}
								{deletePreview?.roomId === room.id && (
									<div className="chat-delete-confirm">
										<p>
											Permanently delete {room.name ?? room.id}? ({deletePreview.message_count} messages,{" "}
											{deletePreview.member_count} members)
										</p>
										<div className="chat-feed-actions">
											<button
												type="button"
												className="button button-small button-danger"
												disabled={busy}
												onClick={() => void runDelete(room.id, false)}
											>
												Confirm delete
											</button>
											<button type="button" className="button button-small" onClick={() => setDeletePreview(null)}>
												Cancel
											</button>
										</div>
									</div>
								)}
							</li>
						))}
					</ul>
				)}
			</section>

			<section className="panel-card">
				<h2 className="panel-title">Deleted principal cleanup</h2>
				<p className="field-hint">
					Remove a deleted principal from any chat rooms that still hold a membership row for them.
				</p>
				<form className="chat-inline-row" onSubmit={cleanupDeletedPrincipal}>
					<label htmlFor={cleanupId} className="visually-hidden">
						Deleted principal ID
					</label>
					<input
						id={cleanupId}
						className="input"
						placeholder="prn_…"
						value={cleanupPrincipalId}
						onChange={(event) => setCleanupPrincipalId(event.target.value)}
						disabled={busy}
					/>
					<button type="submit" className="button" disabled={busy || !cleanupPrincipalId.trim()}>
						Clean up memberships
					</button>
				</form>
			</section>

			<section className="panel-card">
				<h2 className="panel-title">Custom emoji ({emojiList.length})</h2>
				<form className="chat-inline-row" onSubmit={uploadEmoji}>
					<label htmlFor={emojiNameId} className="visually-hidden">
						Emoji name
					</label>
					<input
						id={emojiNameId}
						className="input"
						placeholder="name (e.g. shipit)"
						value={emojiName}
						onChange={(event) => setEmojiName(event.target.value)}
						disabled={busy}
					/>
					<label htmlFor={emojiFileId} className="visually-hidden">
						Emoji image file
					</label>
					<input
						id={emojiFileId}
						type="file"
						accept="image/png,image/jpeg,image/gif,image/webp"
						onChange={(event) => setEmojiFile(event.target.files?.[0] ?? null)}
						disabled={busy}
					/>
					<button type="submit" className="button button-primary" disabled={busy || !emojiName.trim() || !emojiFile}>
						Upload emoji
					</button>
				</form>
				{emojiList.length > 0 && (
					<ul className="chat-admin-emoji-grid">
						{emojiList.map((item) => (
							<li key={item.name} className="chat-admin-emoji-card">
								<img src={item.url_path} alt={`:${item.name}:`} className="chat-custom-emoji" />
								<code>:{item.name}:</code>
								<button
									type="button"
									className="button button-small"
									disabled={busy}
									onClick={() => void deleteEmoji(item.name)}
								>
									Delete
								</button>
							</li>
						))}
					</ul>
				)}
			</section>

			<section className="panel-card">
				<h2 className="panel-title">Slash commands ({commands.length})</h2>
				<form className="chat-form" onSubmit={createCommand}>
					<div className="chat-inline-row">
						<input
							className="input"
							placeholder="command (without /)"
							aria-label="Command name"
							value={cmdName}
							onChange={(event) => setCmdName(event.target.value)}
							disabled={busy}
						/>
						<input
							className="input"
							placeholder="Description"
							aria-label="Command description"
							value={cmdDesc}
							onChange={(event) => setCmdDesc(event.target.value)}
							disabled={busy}
						/>
						<input
							className="input"
							placeholder="Usage hint (optional)"
							aria-label="Usage hint"
							value={cmdHint}
							onChange={(event) => setCmdHint(event.target.value)}
							disabled={busy}
						/>
					</div>
					<div className="chat-inline-row">
						<input
							className="input"
							placeholder="Operation (e.g. chat.post_message)"
							aria-label="Target operation"
							value={cmdOp}
							onChange={(event) => setCmdOp(event.target.value)}
							disabled={busy}
						/>
						<input
							className="input"
							placeholder="JSON input template"
							aria-label="Input template JSON"
							value={cmdTemplate}
							onChange={(event) => setCmdTemplate(event.target.value)}
							disabled={busy}
						/>
						<button
							type="submit"
							className="button button-primary"
							disabled={busy || !cmdName.trim() || !cmdDesc.trim()}
						>
							Add command
						</button>
					</div>
					<p className="field-hint">
						Placeholders: <code>{"{{text}}"}</code>, <code>{"{{room_id}}"}</code>, <code>{"{{caller_id}}"}</code>. Up to{" "}
						{CHAT_LIMITS.slashCommandsPerOrg} commands per organization.
					</p>
				</form>
				{commands.length > 0 && (
					<ul className="chat-admin-list">
						{commands.map((cmd) => (
							<li key={cmd.id} className="chat-admin-row">
								<div className="chat-admin-meta">
									<strong>/{cmd.command}</strong> <span className="muted">→ {cmd.operation}</span>
									<p className="muted">{cmd.description}</p>
								</div>
								<button
									type="button"
									className="button button-small"
									disabled={busy}
									onClick={() => void deleteCommand(cmd.id)}
								>
									Delete
								</button>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
