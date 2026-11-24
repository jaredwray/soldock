import {
	type Principal,
	SHARED_DRIVE_LIMITS,
	type SharedDrive,
	type SharedDriveMember,
	type SharedDriveRole,
} from "@asterra/contracts";
import { type FormEvent, useCallback, useEffect, useId, useMemo, useState } from "react";
import { driveAccessText } from "../../lib/accessChange.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { isAutomated, KIND_NAMES } from "../../lib/principalKind.ts";
import { Select } from "../../lib/Select.tsx";
import { useToast } from "../../lib/toast.tsx";
import { principalOption, usePrincipals } from "../../lib/usePrincipals.ts";
import { AGENT_ROLE_HINT, isLastManager, memberRoles, ROLE_HINT, ROLE_NAMES, roleOptions } from "./sharedDrives.ts";

// The members and the name of one shared drive. Admin › Shared drives shows these parts in a card.
// Drive shows them in a dialog. The parts use only the styles of the shell, because Admin does not
// load the styles of Drive.

function byName(a: Principal, b: Principal): number {
	return a.display_name.localeCompare(b.display_name);
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
	// The agents that did not get the access of their membership in a call of this page.
	const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
	const ids = { heading: useId(), select: useId(), role: useId(), hint: useId(), lastManager: useId() };
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
			setPending((current) => {
				const next = new Set(current);
				next.delete(principal.id);
				for (const id of result.agent_access_pending) next.add(id);
				return next;
			});
			// An agent that the person manages gets the scopes of its role and the drive in its limits.
			const access = driveAccessText(result, () => principal.display_name);
			toast({
				message: `${
					added
						? `${principal.display_name} is now a member of ${driveName}.`
						: `${principal.display_name} is now ${next === "editor" ? "an" : "a"} ${next} of ${driveName}.`
				}${access}`,
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
													{principal && principal.kind !== "human" && (
														<span className="chip chip-small">{KIND_NAMES[principal.kind]}</span>
													)}
													{principal?.archived_at && <span className="chip chip-small">Archived</span>}
												</div>
												<div className="row-note">{principal?.address ?? member.principal_id}</div>
											</td>
											<td>
												{canManage && principal ? (
													<Select
														className="input shared-drive-role"
														label={`Role of ${name}`}
														aria-describedby={last ? ids.lastManager : undefined}
														value={member.role}
														options={roleOptions(memberRoles(principal.kind))}
														disabled={busy || last}
														onChange={(next) => void setMemberRole(principal, next, false)}
													/>
												) : (
													ROLE_NAMES[member.role]
												)}
												{/* A disabled control shows no tooltip, so the reason is text on the page. */}
												{last && (canManage || self) && (
													<div id={ids.lastManager} className="row-note">
														A shared drive keeps at least one manager.
													</div>
												)}
												{/* The role menu sends no call for the role that the member has. This button does. */}
												{canManage && principal && pending.has(member.principal_id) && (
													<div className="row-note">
														{name} cannot use this shared drive yet.{" "}
														<button
															type="button"
															className="link-button"
															onClick={() => void setMemberRole(principal, member.role, false)}
															disabled={busy}
														>
															Try again
														</button>
													</div>
												)}
											</td>
											<td className="cell-actions">
												{principal && (canManage || self) && (
													<button
														type="button"
														className="button button-small"
														aria-label={self ? `Leave ${driveName}` : `Remove ${name} from ${driveName}`}
														aria-describedby={last ? ids.lastManager : undefined}
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
								<Select
									id={ids.select}
									value={candidateId}
									options={candidates.map(principalOption)}
									placeholder="Select a person or an agent"
									onChange={(id) => {
										setCandidateId(id);
										// An agent cannot be a manager, so the role control goes back to the editor role.
										const next = candidates.find((principal) => principal.id === id);
										if (next && !memberRoles(next.kind).includes(role)) setRole("editor");
									}}
									disabled={busy || full || candidates.length === 0}
								/>
							</div>
							<div className="field shared-drive-add-role">
								<label htmlFor={ids.role} className="field-label">
									Role
								</label>
								<Select
									id={ids.role}
									value={role}
									options={roleOptions(roles)}
									onChange={setRole}
									aria-describedby={ids.hint}
									disabled={busy || full}
								/>
							</div>
						</div>
						<p id={ids.hint} className="field-hint">
							{full ? `A shared drive can have at most ${SHARED_DRIVE_LIMITS.members} members.` : ROLE_HINT}
							{!full && candidate && isAutomated(candidate.kind) && ` ${AGENT_ROLE_HINT}`}
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
