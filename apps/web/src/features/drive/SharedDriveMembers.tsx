import {
	type Principal,
	SHARED_DRIVE_LIMITS,
	type SharedDrive,
	type SharedDriveMember,
	type SharedDriveRole,
} from "@soldock/contracts";
import { type FormEvent, useCallback, useEffect, useId, useMemo, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { useToast } from "../../lib/toast.tsx";
import { usePrincipals } from "../../lib/usePrincipals.ts";
import { isLastManager, memberRoles, ROLE_HINT, ROLE_NAMES } from "./sharedDrives.ts";

// The members and the name of one shared drive. Admin › Shared drives shows these parts in a card.
// Drive shows them in a dialog. The parts use only the styles of the shell, because Admin does not
// load the styles of Drive.

function byName(a: Principal, b: Principal): number {
	return a.display_name.localeCompare(b.display_name);
}

function describe(principal: Principal): string {
	return `${principal.display_name} (${principal.address})${principal.kind === "agent" ? ", agent" : ""}`;
}

interface NameFormProps {
	drive: Pick<SharedDrive, "id" | "name">;
	/** Called with the drive that the operation returned. */
	onChanged: (drive: SharedDrive) => void;
}

/** Changes the name of a shared drive (`drive.update_shared_drive`). */
export function SharedDriveNameForm({ drive, onChanged }: NameFormProps) {
	const toast = useToast();
	const [name, setName] = useState(drive.name);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { name: useId(), hint: useId() };
	const unchanged = name.trim() === drive.name;

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return setError("Enter a name.");
		if (unchanged) return;
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("drive.update_shared_drive", { drive_id: drive.id, name: trimmed });
			setName(result.shared_drive.name);
			onChanged(result.shared_drive);
			toast({ message: `${result.shared_drive.name} saved.` });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="admin-card-form" onSubmit={submit} noValidate>
			<div className="field">
				<label htmlFor={ids.name} className="subpanel-title">
					Name
				</label>
				<input
					id={ids.name}
					className="input"
					value={name}
					maxLength={SHARED_DRIVE_LIMITS.nameChars}
					autoComplete="off"
					onChange={(event) => setName(event.target.value)}
					aria-describedby={ids.hint}
					aria-invalid={error ? true : undefined}
					disabled={busy}
				/>
				<p id={ids.hint} className="field-hint">
					Each member sees this name in Drive.
				</p>
			</div>
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<button type="submit" className="button button-primary" disabled={busy || unchanged}>
				{busy ? "Saving…" : "Save name"}
			</button>
		</form>
	);
}

interface MembersPartProps {
	driveId: string;
	driveName: string;
	/** The people and agents of the organization. */
	principals: readonly Principal[];
	/** The id of the person who uses the page. */
	selfId: string;
	/** True for a manager of the drive, an owner or an admin. Each other member sees the list only. */
	canManage: boolean;
	/** Called after each change, with the drive as it is now. */
	onChanged: (drive: SharedDrive) => void;
	/** Called after the person removed themselves and has no other access to the drive. */
	onLeft?: () => void;
}

/**
 * The members of a shared drive, with the role of each one. A person who can manage the drive adds
 * a member, changes a role and removes a member. Each member can remove themselves. The server
 * keeps one manager who is a person: the control of the last manager is off.
 */
export function SharedDriveMembersPart({
	driveId,
	driveName,
	principals,
	selfId,
	canManage,
	onChanged,
	onLeft,
}: MembersPartProps) {
	const toast = useToast();
	const [members, setMembers] = useState<SharedDriveMember[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [candidateId, setCandidateId] = useState("");
	const [role, setRole] = useState<SharedDriveRole>("editor");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [removing, setRemoving] = useState<Principal | null>(null);
	const ids = { heading: useId(), select: useId(), role: useId(), hint: useId() };
	const byId = useMemo(() => new Map(principals.map((principal) => [principal.id, principal])), [principals]);

	const load = useCallback(async () => {
		setLoadError(null);
		try {
			const result = await api.call("drive.get_shared_drive", { drive_id: driveId });
			setMembers(result.members);
			return result.shared_drive;
		} catch (caught) {
			setLoadError(errorMessage(caught));
			return null;
		}
	}, [driveId]);

	useEffect(() => {
		void load();
	}, [load]);

	const memberIds = new Set((members ?? []).map((member) => member.principal_id));
	// An archived account cannot use a drive, so the list does not offer it.
	const candidates = principals
		.filter((principal) => !memberIds.has(principal.id) && principal.archived_at === null)
		.sort(byName);
	const candidate = candidates.find((principal) => principal.id === candidateId) ?? null;
	const roles = memberRoles(candidate?.kind ?? "human");
	const full = (members?.length ?? 0) >= SHARED_DRIVE_LIMITS.members;

	/** Sets the role of a principal. A principal that is not a member becomes one. */
	async function setMemberRole(principal: Principal, next: SharedDriveRole, added: boolean) {
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("drive.add_shared_drive_members", {
				drive_id: driveId,
				members: [{ principal_id: principal.id, role: next }],
			});
			setMembers(result.members);
			onChanged(result.shared_drive);
			toast({
				message: added
					? `${principal.display_name} is now a member of ${driveName}.`
					: `${principal.display_name} is now ${next === "editor" ? "an" : "a"} ${next} of ${driveName}.`,
			});
			return true;
		} catch (caught) {
			setError(errorMessage(caught));
			return false;
		} finally {
			setBusy(false);
		}
	}

	async function add(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!candidate) return setError("Select a person or an agent.");
		if (!roles.includes(role)) return setError("An agent cannot be a manager. Select a different role.");
		if (await setMemberRole(candidate, role, true)) setCandidateId("");
	}

	async function remove(principal: Principal) {
		await api.call("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: principal.id });
		if (principal.id === selfId) {
			toast({ message: `You are no longer a member of ${driveName}.` });
			if (onLeft) return onLeft();
		} else {
			toast({ message: `${principal.display_name} is no longer a member of ${driveName}.` });
		}
		const drive = await load();
		if (drive) onChanged(drive);
	}

	return (
		<section className="panel" aria-labelledby={ids.heading}>
			<h2 id={ids.heading} className="panel-title">
				Members of {driveName}
			</h2>
			<div className="panel-card panel-card-list">
				{members === null && loadError === null && <p className="panel-empty">Loading the members…</p>}
				{members === null && loadError !== null && (
					<p className="panel-empty" role="alert">
						The members did not load. {loadError}{" "}
						<button type="button" className="link-button" onClick={() => void load()}>
							Try again
						</button>
					</p>
				)}
				{members !== null && (
					<div className="table-scroll">
						<table className="table table-rows">
							<caption className="visually-hidden">Members of {driveName}</caption>
							<thead>
								<tr>
									<th scope="col">Name</th>
									<th scope="col">Role</th>
									<th scope="col" className="cell-actions">
										<span className="visually-hidden">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{members.map((member) => {
									// The server leaves out a deleted principal. A principal that the directory does not have yet gets its id.
									const principal = byId.get(member.principal_id);
									const name = principal?.display_name ?? "Unknown account";
									const last = isLastManager(member, members);
									const self = member.principal_id === selfId;
									return (
										<tr key={member.principal_id} className={principal?.archived_at ? "row-muted" : undefined}>
											<td>
												<div className="member-name">
													{name}
													{self && <span className="chip chip-small">You</span>}
													{principal?.kind === "agent" && <span className="chip chip-small">Agent</span>}
													{principal?.archived_at && <span className="chip chip-small">Archived</span>}
												</div>
												<div className="row-note">{principal?.address ?? member.principal_id}</div>
											</td>
											<td>
												{canManage && principal ? (
													<select
														className="input shared-drive-role"
														aria-label={`Role of ${name}`}
														title={last ? "A shared drive keeps at least one manager" : undefined}
														value={member.role}
														disabled={busy || last}
														onChange={(event) =>
															void setMemberRole(principal, event.target.value as SharedDriveRole, false)
														}
													>
														{memberRoles(principal.kind).map((option) => (
															<option key={option} value={option}>
																{ROLE_NAMES[option]}
															</option>
														))}
													</select>
												) : (
													ROLE_NAMES[member.role]
												)}
											</td>
											<td className="cell-actions">
												{principal && (canManage || self) && (
													<button
														type="button"
														className="button button-small"
														aria-label={self ? `Leave ${driveName}` : `Remove ${name} from ${driveName}`}
														title={last ? "A shared drive keeps at least one manager" : undefined}
														onClick={() => setRemoving(principal)}
														disabled={busy || last}
													>
														{self ? "Leave" : "Remove"}
													</button>
												)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				{canManage && members !== null && (
					<form className="panel-form panel-form-divided" onSubmit={add} noValidate>
						<div className="shared-drive-add">
							<div className="field">
								<label htmlFor={ids.select} className="field-label">
									Add a member
								</label>
								<select
									id={ids.select}
									className="input"
									value={candidateId}
									onChange={(event) => {
										setCandidateId(event.target.value);
										// An agent cannot be a manager, so the role control goes back to the editor role.
										const next = candidates.find((principal) => principal.id === event.target.value);
										if (next && !memberRoles(next.kind).includes(role)) setRole("editor");
									}}
									disabled={busy || full || candidates.length === 0}
								>
									<option value="">Select a person or an agent</option>
									{candidates.map((principal) => (
										<option key={principal.id} value={principal.id}>
											{describe(principal)}
										</option>
									))}
								</select>
							</div>
							<div className="field shared-drive-add-role">
								<label htmlFor={ids.role} className="field-label">
									Role
								</label>
								<select
									id={ids.role}
									className="input"
									value={role}
									onChange={(event) => setRole(event.target.value as SharedDriveRole)}
									aria-describedby={ids.hint}
									disabled={busy || full}
								>
									{roles.map((option) => (
										<option key={option} value={option}>
											{ROLE_NAMES[option]}
										</option>
									))}
								</select>
							</div>
						</div>
						<p id={ids.hint} className="field-hint">
							{full ? `A shared drive can have at most ${SHARED_DRIVE_LIMITS.members} members.` : ROLE_HINT}
						</p>
						<button type="submit" className="button button-primary" disabled={busy || full || candidates.length === 0}>
							{busy ? "Please wait…" : "Add member"}
						</button>
					</form>
				)}
			</div>
			{removing && (
				<ConfirmDialog
					title={removing.id === selfId ? "Leave the shared drive?" : "Remove member?"}
					confirmLabel={removing.id === selfId ? "Leave" : "Remove member"}
					danger
					onClose={() => setRemoving(null)}
					onConfirm={() => remove(removing)}
				>
					{removing.id === selfId ? (
						<p>
							Leave {driveName}? Your access through the drive ends at once. A manager can add you again. The items stay
							in the shared drive.
						</p>
					) : (
						<p>
							Remove {removing.display_name} from {driveName}? The access through the drive ends at once. The items stay
							in the shared drive.
						</p>
					)}
				</ConfirmDialog>
			)}
		</section>
	);
}

interface MembersDialogProps {
	drive: Pick<SharedDrive, "id" | "name">;
	selfId: string;
	canManage: boolean;
	onClose: () => void;
	/** Called after each change, with the drive as it is now. */
	onChanged: (drive: SharedDrive) => void;
	/** Called after the person removed themselves. */
	onLeft: () => void;
}

/** The members of a shared drive, in a dialog of Drive. A person who can manage the drive also changes its name. */
export function SharedDriveMembersDialog({ drive, selfId, canManage, onClose, onChanged, onLeft }: MembersDialogProps) {
	const principals = usePrincipals();
	return (
		<Dialog
			title={drive.name}
			onClose={onClose}
			className="dialog-wide"
			description={
				canManage
					? "The members get access to each item of this shared drive, through their role."
					: "Only a manager, an owner or an admin can change the members."
			}
		>
			<div className="dialog-body shared-drive-dialog">
				{principals === null ? (
					<p className="panel-empty" role="status">
						Loading…
					</p>
				) : (
					<>
						{canManage && <SharedDriveNameForm drive={drive} onChanged={onChanged} />}
						<SharedDriveMembersPart
							driveId={drive.id}
							driveName={drive.name}
							principals={principals}
							selfId={selfId}
							canManage={canManage}
							onChanged={onChanged}
							onLeft={onLeft}
						/>
					</>
				)}
			</div>
			<div className="dialog-actions">
				<button type="button" className="button button-primary" onClick={onClose} data-autofocus>
					Done
				</button>
			</div>
		</Dialog>
	);
}
