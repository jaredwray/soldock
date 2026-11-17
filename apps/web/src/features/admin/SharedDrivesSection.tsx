import { type Principal, SHARED_DRIVE_LIMITS, type SharedDrive, type SharedDriveRole } from "@soldock/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { plural } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { Select } from "../../lib/Select.tsx";
import { useToast } from "../../lib/toast.tsx";
import { sharedDrivePath } from "../../routes.ts";
import { listSharedDrives } from "../drive/data.ts";
import { SHARED_DRIVE_ICON } from "../drive/model.ts";
import { SharedDriveMembersPart, SharedDriveNameForm } from "../drive/SharedDriveMembers.tsx";
import { memberRoles, membersProblem, ROLE_HINT, ROLE_NAMES, roleOptions } from "../drive/sharedDrives.ts";
import { TargetWebhooks } from "../settings/TargetWebhooks.tsx";
import { AdminCard } from "./AdminCard.tsx";
import { byName } from "./SharedMailboxPanel.tsx";

interface SectionProps {
	principals: readonly Principal[];
	/** The id of the owner or the admin who uses the page. */
	selfId: string;
}

/**
 * Owners and admins create shared drives, change their names and their members, and delete an empty
 * one. A shared drive owns its items: each member, a person or an agent, gets access through a role.
 * An owner or an admin gets access to the items only as a member.
 */
export function SharedDrivesSection({ principals, selfId }: SectionProps) {
	const toast = useToast();
	const [drives, setDrives] = useState<SharedDrive[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	const load = useCallback(async () => {
		setError(null);
		try {
			setDrives(await listSharedDrives(true));
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	/** Puts the drive that an operation returned into the list, by name. */
	function save(drive: SharedDrive) {
		setDrives((current) =>
			[...(current ?? []).filter((item) => item.id !== drive.id), drive].sort((a, b) => a.name.localeCompare(b.name)),
		);
	}

	return (
		<section className="panel">
			<div className="panel-head">
				<p className="panel-heading panel-intro">
					A shared drive owns its items, so they stay when a person leaves. Each member, a person or an agent, gets
					access through a role. You get access to the items only when you are a member.
				</p>
				<button
					type="button"
					className="button button-primary"
					onClick={() => setCreating(true)}
					disabled={drives === null}
				>
					<Icon name="plus" size={18} />
					New shared drive
				</button>
			</div>
			{drives === null && !error && <p className="panel-card panel-empty">Loading shared drives…</p>}
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			{drives === null && error && (
				<div>
					<button type="button" className="button" onClick={() => void load()}>
						Try again
					</button>
				</div>
			)}
			{drives !== null && drives.length === 0 && (
				<p className="panel-card panel-empty">There are no shared drives yet.</p>
			)}
			{drives !== null && drives.length > 0 && (
				<div className="admin-card-list">
					{drives.map((drive) => (
						<SharedDrivePanel
							key={drive.id}
							drive={drive}
							principals={principals}
							selfId={selfId}
							onChanged={save}
							onDeleted={() => {
								setDrives((current) => (current ?? []).filter((item) => item.id !== drive.id));
								toast({ message: `Shared drive ${drive.name} deleted.` });
							}}
						/>
					))}
				</div>
			)}
			{creating && (
				<CreateSharedDriveDialog
					principals={principals}
					selfId={selfId}
					onClose={() => setCreating(false)}
					onCreated={(drive) => {
						save(drive);
						setCreating(false);
					}}
				/>
			)}
		</section>
	);
}

interface PanelProps {
	drive: SharedDrive;
	principals: readonly Principal[];
	selfId: string;
	onChanged: (drive: SharedDrive) => void;
	onDeleted: () => void;
}

/** One shared drive, as a card: its name, its members and the control that deletes it. */
function SharedDrivePanel({ drive, principals, selfId, onChanged, onDeleted }: PanelProps) {
	const [deleting, setDeleting] = useState(false);
	return (
		<AdminCard
			icon={SHARED_DRIVE_ICON}
			name={drive.name}
			address={drive.role === null ? "You are not a member" : `You are a member: ${ROLE_NAMES[drive.role]}`}
			chips={<span className="chip">{plural(drive.member_count, "member")}</span>}
		>
			<SharedDriveNameForm drive={drive} onChanged={onChanged} />
			<SharedDriveMembersPart
				driveId={drive.id}
				driveName={drive.name}
				principals={principals}
				selfId={selfId}
				canManage
				onChanged={onChanged}
			/>
			<TargetWebhooks
				heading={`Webhooks of ${drive.name}`}
				targetId={drive.id}
				targetName={drive.name}
				domains={["drive"]}
				canCreate={false}
				note="Members add a webhook in Settings. You can clear an event here."
			/>
			<div className="admin-card-meta">
				<div>
					<h2 className="subpanel-title">Delete {drive.name}</h2>
					<p className="field-hint">
						{drive.role === null ? (
							"Only an empty shared drive can be deleted. Its members move or delete the items first."
						) : (
							<>
								Only an empty shared drive can be deleted. Move or delete its items first, also the items in its trash.{" "}
								<Link to={sharedDrivePath(drive.id)}>Open {drive.name} in Drive</Link>
							</>
						)}
					</p>
				</div>
				<button type="button" className="button button-danger-outline" onClick={() => setDeleting(true)}>
					<Icon name="trash" size={16} />
					Delete shared drive
				</button>
			</div>
			{deleting && (
				<ConfirmDialog
					title="Delete the shared drive?"
					confirmLabel="Delete shared drive"
					danger
					onClose={() => setDeleting(false)}
					onConfirm={async () => {
						await api.call("drive.delete_shared_drive", { drive_id: drive.id });
						onDeleted();
					}}
				>
					<p>
						Delete {drive.name}? Its members lose the drive. You cannot get it back. The server refuses this while the
						drive holds an item.
					</p>
				</ConfirmDialog>
			)}
		</AdminCard>
	);
}

interface CreateProps {
	principals: readonly Principal[];
	selfId: string;
	onClose: () => void;
	onCreated: (drive: SharedDrive) => void;
}

/** A new shared drive: its name, and the first members with a role each. */
function CreateSharedDriveDialog({ principals, selfId, onClose, onCreated }: CreateProps) {
	const toast = useToast();
	const [name, setName] = useState("");
	// The role of each selected principal, by id. The person who creates the drive starts as a manager.
	const [roles, setRoles] = useState<ReadonlyMap<string, SharedDriveRole>>(() => new Map([[selfId, "manager"]]));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// One key for the dialog, so a retry after a lost answer does not make a second drive.
	const [idempotencyKey] = useState(() => crypto.randomUUID());
	const ids = { name: useId(), hint: useId() };
	// People first, then agents. An archived account cannot use a drive, so the list does not offer it.
	const sorted = principals
		.filter((principal) => principal.archived_at === null)
		.sort((a, b) => a.kind.localeCompare(b.kind) * -1 || byName(a, b));

	function setRole(id: string, role: SharedDriveRole | null) {
		setRoles((current) => {
			const next = new Map(current);
			if (role === null) next.delete(id);
			else next.set(id, role);
			return next;
		});
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!name.trim()) return setError("Enter a name.");
		const members = sorted.flatMap((principal) => {
			const role = roles.get(principal.id);
			return role ? [{ principal, role }] : [];
		});
		const problem = membersProblem(
			members.map(({ principal, role }) => ({ kind: principal.kind, role, name: principal.display_name })),
		);
		if (problem) return setError(problem);
		if (members.length > SHARED_DRIVE_LIMITS.members) {
			return setError(`A shared drive can have at most ${SHARED_DRIVE_LIMITS.members} members.`);
		}
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("drive.create_shared_drive", {
				name: name.trim(),
				members: members.map(({ principal, role }) => ({ principal_id: principal.id, role })),
				idempotency_key: idempotencyKey,
			});
			onCreated(result.shared_drive);
			toast({ message: `Shared drive ${result.shared_drive.name} created.` });
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog title="New shared drive" onClose={() => !busy && onClose()}>
			<form onSubmit={submit} noValidate>
				<div className="dialog-body form-grid">
					<div className="field form-grid-wide">
						<label htmlFor={ids.name} className="field-label">
							Name
						</label>
						<input
							id={ids.name}
							className="input"
							value={name}
							maxLength={SHARED_DRIVE_LIMITS.nameChars}
							autoComplete="off"
							onChange={(event) => setName(event.target.value)}
							disabled={busy}
							placeholder="Design"
							data-autofocus
						/>
					</div>
					<fieldset className="scope-list form-grid-wide" aria-describedby={ids.hint}>
						<legend className="field-label">Members</legend>
						{sorted.map((principal) => {
							const role = roles.get(principal.id);
							return (
								<div key={principal.id} className="shared-drive-pick">
									<label className="check-row">
										<input
											type="checkbox"
											className="checkbox"
											checked={role !== undefined}
											onChange={() => setRole(principal.id, role === undefined ? "editor" : null)}
											disabled={busy}
										/>
										<span>
											{principal.display_name}
											{principal.id === selfId ? " (you)" : ""}
											<span className="check-hint">
												{principal.address}
												{principal.kind === "agent" ? " · agent" : ""}
											</span>
										</span>
									</label>
									<Select
										className="input shared-drive-role"
										label={`Role of ${principal.display_name}`}
										value={role ?? "editor"}
										options={roleOptions(memberRoles(principal.kind))}
										disabled={busy || role === undefined}
										onChange={(next) => setRole(principal.id, next)}
									/>
								</div>
							);
						})}
						<p id={ids.hint} className="field-hint">
							{ROLE_HINT} At least one person is a manager. You can also change the members later.
						</p>
					</fieldset>
					{error && (
						<p className="form-error form-grid-wide" role="alert">
							{error}
						</p>
					)}
				</div>
				<div className="dialog-actions">
					<button type="button" className="button" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" className="button button-primary" disabled={busy}>
						{busy ? "Creating…" : "Create shared drive"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}
