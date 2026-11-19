import type { DriveItem, Permission, Principal } from "@asterra/contracts";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { initials } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Select } from "../../lib/Select.tsx";
import { principalOption } from "../../lib/usePrincipals.ts";
import { isSharedDriveId } from "../../routes.ts";
import { useSession } from "../auth/session.tsx";
import { usePrincipals } from "./data.ts";
import { canShare, linkPath, SHARED_DRIVE_ICON, spaceInput } from "./model.ts";

type GrantRole = Permission["role"];

const ROLE_NAMES: Record<GrantRole | "owner", string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

const ROLE_OPTIONS: readonly { value: GrantRole; label: string }[] = [
	{ value: "viewer", label: ROLE_NAMES.viewer },
	{ value: "editor", label: ROLE_NAMES.editor },
];

export interface ShareDialogProps {
	item: DriveItem;
	onClose: () => void;
	/** After a grant was added, changed or removed. */
	onChanged?: () => void;
}

interface Access {
	ownerId: string;
	permissions: Permission[];
}

/**
 * Who can use an item. The owner adds a person or an agent with the viewer or the editor role,
 * changes a role and removes a grant. Each other person sees the list only. A grant from a folder
 * above the item shows as text: the owner changes it on that folder.
 *
 * An item of a shared drive has no owner. A manager of the drive shares the item with a person or an
 * agent that is not a member. The members have access through their role, and are not in the list.
 */
export function ShareDialog({ item, onClose, onChanged }: ShareDialogProps) {
	const ownId = useSession().whoami.principal.id;
	const principals = usePrincipals();
	const [access, setAccess] = useState<Access | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [principalId, setPrincipalId] = useState("");
	const [role, setRole] = useState<GrantRole>("viewer");
	const [copied, setCopied] = useState(false);
	const personId = useId();
	const roleId = useId();
	const isOwner = canShare(item);
	const inSharedDrive = isSharedDriveId(item.space_id);
	const space = spaceInput(item.space_id, ownId);
	const path = linkPath(item);

	const load = useCallback(async () => {
		try {
			const result = await api.call("drive.list_permissions", {
				...spaceInput(item.space_id, ownId),
				item_id: item.id,
			});
			setAccess({ ownerId: result.owner_id, permissions: result.permissions });
			setLoadError(null);
		} catch (caught) {
			setLoadError(errorMessage(caught));
		}
	}, [item.id, item.space_id, ownId]);

	useEffect(() => {
		void load();
	}, [load]);

	const byId = useMemo(() => new Map((principals ?? []).map((principal) => [principal.id, principal])), [principals]);

	// A principal with a grant on the item itself is not offered again: the row changes its role.
	const candidates = useMemo(() => {
		const direct = new Set((access?.permissions ?? []).filter((p) => !p.inherited).map((p) => p.principal_id));
		return (principals ?? [])
			.filter((principal) => principal.id !== ownId && principal.id !== access?.ownerId && !direct.has(principal.id))
			.sort((a, b) => a.display_name.localeCompare(b.display_name));
	}, [principals, access, ownId]);

	/** Runs one change, then gets the list again. The dialog stays open and shows the error if it throws. */
	async function change(action: () => Promise<unknown>) {
		setBusy(true);
		setError(null);
		try {
			await action();
			await load();
			onChanged?.();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	function add(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!principalId) {
			setError("Select a person or an agent.");
			return;
		}
		void change(async () => {
			await api.call("drive.share_item", { ...space, item_id: item.id, principal_id: principalId, role });
			setPrincipalId("");
		});
	}

	async function copyLink() {
		if (path === null) return;
		try {
			await navigator.clipboard.writeText(new URL(path, window.location.origin).href);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 3000);
		} catch {
			setError("The browser did not copy the link.");
		}
	}

	return (
		<Dialog
			title={`Share “${item.name}”`}
			onClose={onClose}
			description={
				inSharedDrive
					? isOwner
						? "The members of the shared drive have access. You can also share this item with a person or an agent that is not a member."
						: "The members of the shared drive have access. Only a manager can change the other shares."
					: isOwner
						? "Only people and agents of this organization can get access."
						: "Only the owner can change who has access."
			}
		>
			<div className="dialog-body">
				{isOwner && (
					<form className="drive-share-add" onSubmit={add} noValidate>
						<div className="drive-share-person">
							<label htmlFor={personId} className="field-label">
								Person or agent
							</label>
							<Select
								id={personId}
								value={principalId}
								options={candidates.map(principalOption)}
								placeholder={principals === null ? "Loading…" : "Select…"}
								disabled={busy || principals === null}
								onChange={setPrincipalId}
								data-autofocus
							/>
						</div>
						<div>
							<label htmlFor={roleId} className="field-label">
								Role
							</label>
							<Select id={roleId} value={role} options={ROLE_OPTIONS} disabled={busy} onChange={setRole} />
						</div>
						<button type="submit" className="button button-primary" disabled={busy}>
							Share
						</button>
					</form>
				)}
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				<h3 className="drive-share-heading">People and agents with access</h3>
				{access === null && loadError === null && (
					<p className="drive-picker-state" role="status">
						<span className="spinner spinner-small" aria-hidden="true" /> Loading…
					</p>
				)}
				{loadError !== null && access === null && (
					<p className="form-error" role="alert">
						The list did not load. {loadError}{" "}
						<button type="button" className="link-button" onClick={() => void load()}>
							Try again
						</button>
					</p>
				)}
				{access !== null && (
					<ul className="drive-share-list">
						{inSharedDrive ? (
							<li className="drive-share-row">
								<span className="avatar" aria-hidden="true">
									<Icon name={SHARED_DRIVE_ICON} size={18} />
								</span>
								<span className="drive-share-who">
									<strong>Members of the shared drive</strong>
									<span className="muted">Each member has access through the role in the drive</span>
								</span>
								<span className="drive-share-control">
									<span className="muted">Owner</span>
								</span>
							</li>
						) : (
							<AccessRow principal={byId.get(access.ownerId)} principalId={access.ownerId} ownId={ownId}>
								<span className="muted">Owner</span>
							</AccessRow>
						)}
						{access.permissions.map((permission) => {
							const principal = byId.get(permission.principal_id);
							const name = principal?.display_name ?? "this principal";
							return (
								<AccessRow
									key={`${permission.item_id}:${permission.principal_id}`}
									principal={principal}
									principalId={permission.principal_id}
									ownId={ownId}
								>
									{permission.inherited || !isOwner ? (
										<span className="muted">
											{ROLE_NAMES[permission.role]}
											{permission.inherited && ", from a folder above"}
										</span>
									) : (
										<>
											<Select
												className="input drive-share-role"
												label={`Role of ${name}`}
												value={permission.role}
												options={ROLE_OPTIONS}
												disabled={busy}
												onChange={(role) =>
													void change(() =>
														api.call("drive.share_item", {
															...space,
															item_id: item.id,
															principal_id: permission.principal_id,
															role,
														}),
													)
												}
											/>
											<button
												type="button"
												className="icon-button icon-button-small"
												aria-label={`Remove the access of ${name}`}
												title="Remove access"
												disabled={busy}
												onClick={() =>
													void change(() =>
														api.call("drive.unshare_item", {
															...space,
															item_id: item.id,
															principal_id: permission.principal_id,
														}),
													)
												}
											>
												<Icon name="close" size={18} />
											</button>
										</>
									)}
								</AccessRow>
							);
						})}
					</ul>
				)}
			</div>
			<div className="dialog-actions drive-share-actions">
				{path !== null && (
					<button type="button" className="button" onClick={() => void copyLink()}>
						<Icon name={copied ? "check" : "link"} size={16} />
						<span aria-live="polite">{copied ? "Link copied" : "Copy link"}</span>
					</button>
				)}
				<button type="button" className="button button-primary" onClick={onClose}>
					Done
				</button>
			</div>
		</Dialog>
	);
}

function AccessRow({
	principal,
	principalId,
	ownId,
	children,
}: {
	principal: Principal | undefined;
	principalId: string;
	ownId: string;
	children: ReactNode;
}) {
	const name = principal?.display_name ?? "Unknown account";
	return (
		<li className="drive-share-row">
			<span className="avatar" aria-hidden="true">
				{initials(name)}
			</span>
			<span className="drive-share-who">
				<strong>
					{name}
					{principalId === ownId && " (you)"}
					{principal?.kind === "agent" && " (agent)"}
				</strong>
				<span className="muted">{principal?.address ?? principalId}</span>
			</span>
			<span className="drive-share-control">{children}</span>
		</li>
	);
}
