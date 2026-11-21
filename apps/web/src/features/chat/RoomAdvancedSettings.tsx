import {
	CHAT_LIMITS,
	type ChatIncomingWebhook,
	type ChatMember,
	type ChatRoom,
	type ChatSection,
	type PostingPolicy,
} from "@asterra/contracts";
import { useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
import { navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { CHAT_PATH } from "../../routes.ts";
import { isOrgAdmin, useSession } from "../auth/session.tsx";

/**
 * Layer 8 room controls rendered inside `RoomSettingsDialog`:
 * sidebar section, posting rules, retention, archive/unarchive, delete (with dry-run),
 * incoming webhooks (signing secret shown once), and JSON export (org owners).
 */
export function RoomAdvancedSettings({
	room,
	members,
	postAllowedIds,
	sections,
	onChanged,
	onDeleted,
}: {
	room: ChatRoom;
	members: readonly ChatMember[];
	postAllowedIds: readonly string[];
	sections: readonly ChatSection[];
	onChanged: () => void;
	onDeleted: () => void;
}) {
	const self = useSession().whoami.principal;
	const orgAdmin = isOrgAdmin(self);
	const orgOwner = self.org_role === "owner";
	const isNamedRoom = room.kind === "public" || room.kind === "private";
	const isRoomOwner = room.role === "owner";
	const canManageRules = isNamedRoom && (isRoomOwner || orgAdmin);
	const canManageWebhooks = isNamedRoom && isRoomOwner;
	const toast = useToast();

	// Sidebar section
	const currentSection = sections.find((s) => s.room_ids.includes(room.id))?.id ?? "";
	const [sectionId, setSectionId] = useState(currentSection);
	const sectionSelectId = useId();

	// Posting rules
	const [policy, setPolicy] = useState<PostingPolicy>(room.posting_policy);
	const [allowedIds, setAllowedIds] = useState<string[]>([...postAllowedIds]);

	// Retention
	const [retentionInput, setRetentionInput] = useState(room.retention_days === null ? "" : String(room.retention_days));
	const [retentionPreview, setRetentionPreview] = useState<number | null>(null);
	const retentionId = useId();

	// Delete preview
	const [deletePreview, setDeletePreview] = useState<{ message_count: number; member_count: number } | null>(null);

	// Incoming webhooks
	const [webhooks, setWebhooks] = useState<ChatIncomingWebhook[] | null>(null);
	const [newHookName, setNewHookName] = useState("");
	const [createdSecret, setCreatedSecret] = useState<{ name: string; url_path: string; signing_secret: string } | null>(
		null,
	);
	const hookNameId = useId();

	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setSectionId(currentSection);
	}, [currentSection]);

	const loadWebhooks = useCallback(async () => {
		if (!canManageWebhooks) return;
		try {
			const res = await api.call("chat.list_incoming_webhooks", { room_id: room.id });
			setWebhooks(res.webhooks);
		} catch {
			setWebhooks([]);
		}
	}, [canManageWebhooks, room.id]);

	useEffect(() => {
		void loadWebhooks();
	}, [loadWebhooks]);

	async function assignSection(nextId: string) {
		setBusy(true);
		setError(null);
		try {
			await api.call("chat.set_room_section", { room_id: room.id, section_id: nextId === "" ? null : nextId });
			setSectionId(nextId);
			onChanged();
			toast({ message: "Sidebar section updated." });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function savePostingRules() {
		setBusy(true);
		setError(null);
		try {
			await api.call("chat.set_posting_rules", {
				room_id: room.id,
				policy,
				...(policy === "allowlist" ? { allowed_principal_ids: allowedIds } : {}),
			});
			onChanged();
			toast({ message: "Posting rules saved." });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function runRetention(dryRun: boolean) {
		const trimmed = retentionInput.trim();
		const days = trimmed === "" ? null : Number(trimmed);
		if (days !== null && (!Number.isInteger(days) || days < 1 || days > CHAT_LIMITS.retentionMaxDays)) {
			setError(`Enter a whole number between 1 and ${CHAT_LIMITS.retentionMaxDays}, or leave blank.`);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const res = await api.call("chat.set_room_retention", {
				room_id: room.id,
				retention_days: days,
				dry_run: dryRun,
			});
			if (dryRun) {
				setRetentionPreview(res.purged_count);
			} else {
				setRetentionPreview(null);
				onChanged();
				toast({
					message:
						days === null
							? "Retention rule cleared."
							: `Retention set to ${days} days (${res.purged_count} old messages removed).`,
				});
			}
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function toggleArchive() {
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
			onChanged();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function runDelete(dryRun: boolean) {
		setBusy(true);
		setError(null);
		try {
			const res = await api.call("chat.delete_room", { room_id: room.id, dry_run: dryRun });
			if (dryRun) {
				setDeletePreview({ message_count: res.message_count, member_count: res.member_count });
			} else {
				toast({ message: "Room deleted." });
				onDeleted();
				navigate(CHAT_PATH);
			}
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function createWebhook() {
		if (!newHookName.trim()) {
			setError("Enter a name for the incoming webhook.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const res = await api.call("chat.create_incoming_webhook", {
				room_id: room.id,
				name: newHookName.trim(),
			});
			setNewHookName("");
			setCreatedSecret({
				name: res.webhook.name,
				url_path: res.webhook.url_path,
				signing_secret: res.signing_secret,
			});
			await loadWebhooks();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function deleteWebhook(webhookId: string) {
		setBusy(true);
		setError(null);
		try {
			await api.call("chat.delete_incoming_webhook", { webhook_id: webhookId });
			await loadWebhooks();
			toast({ message: "Incoming webhook deleted." });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function exportRoom() {
		setBusy(true);
		setError(null);
		try {
			const pages: unknown[] = [];
			let afterSeq = 0;
			let firstMeta: Record<string, unknown> | null = null;
			for (let i = 0; i < 50; i++) {
				const page = await api.call("chat.export_room", { room_id: room.id, after_seq: afterSeq });
				if (!firstMeta) {
					firstMeta = {
						room: page.room,
						members: page.members,
						pins: page.pins,
						exported_at: page.exported_at,
					};
				}
				pages.push(...page.messages);
				if (page.next_after_seq === null) break;
				afterSeq = page.next_after_seq;
			}
			const blob = new Blob([JSON.stringify({ ...firstMeta, messages: pages }, null, 2)], {
				type: "application/json",
			});
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `chat-export-${room.id}.json`;
			link.click();
			URL.revokeObjectURL(url);
			toast({ message: "Room export downloaded." });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="room-advanced-settings">
			{sections.length > 0 && (
				<section className="room-setting-block">
					<h4>
						<Icon name="folder" size={16} /> Sidebar section
					</h4>
					<div className="chat-inline-row">
						<label htmlFor={sectionSelectId} className="visually-hidden">
							Sidebar section
						</label>
						<select
							id={sectionSelectId}
							className="input"
							value={sectionId}
							disabled={busy}
							onChange={(event) => void assignSection(event.target.value)}
						>
							<option value="">Default section</option>
							{sections.map((s) => (
								<option key={s.id} value={s.id}>
									{s.name}
								</option>
							))}
						</select>
					</div>
				</section>
			)}

			{canManageRules && (
				<>
					<section className="room-setting-block">
						<h4>
							<Icon name="shield" size={16} /> Posting rules
						</h4>
						<div className="chat-inline-row">
							<select
								className="input"
								aria-label="Who can post"
								value={policy}
								disabled={busy}
								onChange={(event) => setPolicy(event.target.value as PostingPolicy)}
							>
								<option value="members">All members</option>
								<option value="owners_only">Room owners only</option>
								<option value="allowlist">Selected members and owners</option>
							</select>
							<button
								type="button"
								className="button button-small"
								disabled={busy}
								onClick={() => void savePostingRules()}
							>
								Apply
							</button>
						</div>
						{policy === "allowlist" && (
							<ul className="chat-allowlist">
								{members
									.filter((m) => m.role !== "owner")
									.map((member) => {
										const checked = allowedIds.includes(member.principal_id);
										return (
											<li key={member.principal_id}>
												<label className="chat-inline-check">
													<input
														type="checkbox"
														checked={checked}
														onChange={() =>
															setAllowedIds((curr) =>
																checked
																	? curr.filter((id) => id !== member.principal_id)
																	: [...curr, member.principal_id],
															)
														}
													/>
													{member.display_name}
												</label>
											</li>
										);
									})}
							</ul>
						)}
					</section>

					<section className="room-setting-block">
						<h4>
							<Icon name="clock" size={16} /> Message retention
						</h4>
						<div className="chat-inline-row">
							<label htmlFor={retentionId} className="visually-hidden">
								Retention days
							</label>
							<input
								id={retentionId}
								type="number"
								min={1}
								max={CHAT_LIMITS.retentionMaxDays}
								className="input"
								placeholder="Keep forever"
								value={retentionInput}
								disabled={busy}
								onChange={(event) => {
									setRetentionInput(event.target.value);
									setRetentionPreview(null);
								}}
							/>
							<button
								type="button"
								className="button button-small"
								disabled={busy}
								onClick={() => void runRetention(true)}
							>
								Preview
							</button>
							<button
								type="button"
								className="button button-small button-primary"
								disabled={busy}
								onClick={() => void runRetention(false)}
							>
								Save
							</button>
						</div>
						{retentionPreview !== null && (
							<p className="field-hint">
								Preview: {retentionPreview} {retentionPreview === 1 ? "message" : "messages"} would be deleted now.
							</p>
						)}
					</section>
				</>
			)}

			{canManageWebhooks && (
				<section className="room-setting-block">
					<h4>
						<Icon name="link" size={16} /> Incoming webhooks
					</h4>
					<div className="chat-inline-row">
						<label htmlFor={hookNameId} className="visually-hidden">
							Webhook name
						</label>
						<input
							id={hookNameId}
							className="input"
							value={newHookName}
							maxLength={CHAT_LIMITS.incomingWebhookNameChars}
							placeholder="Webhook name (e.g. Deploy alerts)"
							disabled={busy}
							onChange={(event) => setNewHookName(event.target.value)}
						/>
						<button type="button" className="button button-small" disabled={busy} onClick={() => void createWebhook()}>
							Add
						</button>
					</div>
					{createdSecret && (
						<div className="chat-secret-box" role="status">
							<p>
								<strong>{createdSecret.name}</strong> created. Copy this signing secret now; it is shown only once.
							</p>
							<p>
								URL: <code>{`${window.location.origin}${createdSecret.url_path}`}</code>
							</p>
							<p>
								Secret: <code>{createdSecret.signing_secret}</code>
							</p>
						</div>
					)}
					{webhooks && webhooks.length > 0 && (
						<ul className="chat-mini-list">
							{webhooks.map((hook) => (
								<li key={hook.id} className="chat-mini-row">
									<span>
										<strong>{hook.name}</strong> <code>{hook.url_path}</code>
									</span>
									<button
										type="button"
										className="button button-small"
										disabled={busy}
										onClick={() => void deleteWebhook(hook.id)}
									>
										Delete
									</button>
								</li>
							))}
						</ul>
					)}
				</section>
			)}

			{(canManageRules || orgOwner) && (
				<section className="room-setting-block room-setting-danger">
					<h4>
						<Icon name="warning" size={16} /> Room lifecycle & export
					</h4>
					<div className="chat-feed-actions">
						{canManageRules && (
							<button
								type="button"
								className="button button-small"
								disabled={busy}
								onClick={() => void toggleArchive()}
							>
								{room.archived_at === null ? "Archive room" : "Unarchive room"}
							</button>
						)}
						{orgOwner && (
							<button type="button" className="button button-small" disabled={busy} onClick={() => void exportRoom()}>
								Export JSON
							</button>
						)}
						{canManageRules && !deletePreview && (
							<button
								type="button"
								className="button button-small button-danger-outline"
								disabled={busy}
								onClick={() => void runDelete(true)}
							>
								Delete room…
							</button>
						)}
					</div>
					{deletePreview && (
						<div className="chat-delete-confirm">
							<p>
								This permanently deletes this room ({deletePreview.message_count} messages, {deletePreview.member_count}{" "}
								members).
							</p>
							<div className="chat-feed-actions">
								<button
									type="button"
									className="button button-small button-danger"
									disabled={busy}
									onClick={() => void runDelete(false)}
								>
									Confirm permanent delete
								</button>
								<button
									type="button"
									className="button button-small"
									disabled={busy}
									onClick={() => setDeletePreview(null)}
								>
									Cancel
								</button>
							</div>
						</div>
					)}
				</section>
			)}

			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
