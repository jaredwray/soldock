import type { CreatedApiKey, Principal } from "@soldock/contracts";
import { useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { Icon } from "../../lib/icons.tsx";
import { useToast } from "../../lib/toast.tsx";
import { CreatePrincipalDialog } from "./CreatePrincipalForm.tsx";
import { EditPrincipalDialog } from "./EditPrincipalDialog.tsx";
import { policySummary } from "./policy.ts";
import { ResetSignInDialog } from "./ResetSignInDialog.tsx";

const ROLE_NAMES = { owner: "Owner", admin: "Admin", member: "Member" } as const;

type Action = { kind: "create" } | { kind: "edit" | "sign-in" | "archive" | "delete"; principal: Principal };

interface MembersSectionProps {
	me: Principal;
	principals: readonly Principal[];
	/** Called after each change, so the page loads the directory again. */
	onChanged: () => void;
	onCreated: (principal: Principal, key: CreatedApiKey) => void;
}

/**
 * The directory: each person and agent, with the controls of owners and admins. Edit changes the name,
 * the role or the sponsor. Reset sign-in sets a new password for a person. Archive stops each credential
 * and keeps the data, and Restore undoes it. Delete removes the principal from the directory. The owner
 * and you have no Reset sign-in, Archive or Delete, and only the owner edits the owner, as on the server.
 */
export function MembersSection({ me, principals, onChanged, onCreated }: MembersSectionProps) {
	const toast = useToast();
	const [action, setAction] = useState<Action | null>(null);
	const byId = new Map(principals.map((p) => [p.id, p]));
	const humans = principals.filter((p) => p.kind === "human");
	const sorted = [...principals].sort(
		(a, b) => a.kind.localeCompare(b.kind) || a.display_name.localeCompare(b.display_name),
	);
	const canEdit = (p: Principal) => p.org_role !== "owner" || p.id === me.id;
	const canRemove = (p: Principal) => p.org_role !== "owner" && p.id !== me.id;

	async function restore(principal: Principal) {
		try {
			await api.call("directory.restore_principal", { principal_id: principal.id });
			toast({ message: `${principal.display_name} is restored.` });
			onChanged();
		} catch (caught) {
			toast({ message: `${principal.display_name} was not restored. ${errorMessage(caught)}`, tone: "error" });
		}
	}

	return (
		<div className="card">
			<div className="section-toolbar">
				<p className="muted">
					The people and agents of the organization. An archived account cannot sign in, and keeps its mail and files.
				</p>
				<button type="button" className="button button-primary" onClick={() => setAction({ kind: "create" })}>
					<Icon name="plus" size={18} />
					New person or agent
				</button>
			</div>
			<div className="table-scroll">
				<table className="table">
					<caption className="visually-hidden">People and agents of the organization</caption>
					<thead>
						<tr>
							<th scope="col">Name</th>
							<th scope="col" className="col-optional">
								Kind
							</th>
							<th scope="col">Role</th>
							<th scope="col" className="col-optional">
								Sponsor
							</th>
							<th scope="col" className="col-optional">
								Agent policy
							</th>
							<th scope="col" className="cell-actions">
								<span className="visually-hidden">Actions</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{sorted.map((principal) => {
							const archived = principal.archived_at !== null;
							return (
								<tr key={principal.id} className={archived ? "row-muted" : undefined}>
									<td className="member-cell">
										<div className="member-name">
											{principal.display_name}
											{principal.id === me.id && <span className="muted"> (you)</span>}
											{/* A phone has no Kind column, so an agent gets its chip here. */}
											{principal.kind === "agent" && <span className="kind kind-agent kind-inline">Agent</span>}
											{archived && <span className="chip chip-small">Archived</span>}
										</div>
										<div className="cell-address muted">{principal.address}</div>
									</td>
									<td className="col-optional">
										<span className={`kind kind-${principal.kind}`}>
											{principal.kind === "agent" ? "Agent" : "Person"}
										</span>
									</td>
									<td>{principal.org_role ? ROLE_NAMES[principal.org_role] : "—"}</td>
									<td className="col-optional">
										{principal.sponsor_id ? (byId.get(principal.sponsor_id)?.display_name ?? "Unknown") : "—"}
									</td>
									<td className="col-optional">
										{principal.outbound_policy ? policySummary(principal.outbound_policy) : "—"}
									</td>
									<td className="cell-actions">
										<div className="row-actions">
											{canEdit(principal) && (
												<RowButton
													icon="pencil"
													label={`Edit ${principal.display_name}`}
													onClick={() => setAction({ kind: "edit", principal })}
												/>
											)}
											{canRemove(principal) && principal.kind === "human" && (
												<RowButton
													icon="lock"
													label={`Reset the sign-in of ${principal.display_name}`}
													onClick={() => setAction({ kind: "sign-in", principal })}
												/>
											)}
											{canRemove(principal) &&
												(archived ? (
													<RowButton
														icon="restore"
														label={`Restore ${principal.display_name}`}
														onClick={() => void restore(principal)}
													/>
												) : (
													<RowButton
														icon="archive"
														label={`Archive ${principal.display_name}`}
														onClick={() => setAction({ kind: "archive", principal })}
													/>
												))}
											{canRemove(principal) && (
												<RowButton
													icon="trash"
													label={`Delete ${principal.display_name}`}
													onClick={() => setAction({ kind: "delete", principal })}
												/>
											)}
										</div>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			{action?.kind === "create" && (
				<CreatePrincipalDialog
					me={me}
					humans={humans}
					onClose={() => setAction(null)}
					onCreated={(principal, key) => {
						setAction(null);
						onCreated(principal, key);
					}}
				/>
			)}
			{action?.kind === "edit" && (
				<EditPrincipalDialog
					me={me}
					principal={action.principal}
					humans={humans}
					onClose={() => setAction(null)}
					onSaved={(principal) => {
						setAction(null);
						toast({ message: `${principal.display_name} saved.` });
						onChanged();
					}}
				/>
			)}
			{action?.kind === "sign-in" && <ResetSignInDialog person={action.principal} onClose={() => setAction(null)} />}
			{action?.kind === "archive" && (
				<ConfirmDialog
					title={`Archive ${action.principal.display_name}?`}
					confirmLabel="Archive"
					danger
					onClose={() => setAction(null)}
					onConfirm={async () => {
						await api.call("directory.archive_principal", { principal_id: action.principal.id });
						toast({ message: `${action.principal.display_name} is archived.` });
						onChanged();
					}}
				>
					<p>
						{action.principal.kind === "agent" ? "The agent" : "They"} cannot sign in, and each API key and connected
						app stops working at once. Each open session ends.
					</p>
					<p>
						The mail, the files and the chat stay, and mail to {action.principal.address} still arrives. You can restore
						the account later.
					</p>
				</ConfirmDialog>
			)}
			{action?.kind === "delete" && (
				<DeleteDialog
					principal={action.principal}
					sponsored={principals.filter((p) => p.sponsor_id === action.principal.id)}
					onClose={() => setAction(null)}
					onDeleted={() => {
						toast({ message: `${action.principal.display_name} is deleted.` });
						onChanged();
					}}
				/>
			)}
		</div>
	);
}

function RowButton({
	icon,
	label,
	onClick,
}: {
	icon: "pencil" | "lock" | "archive" | "restore" | "trash";
	label: string;
	onClick: () => void;
}) {
	return (
		<button type="button" className="icon-button" aria-label={label} title={label} onClick={onClick}>
			<Icon name={icon} size={18} />
		</button>
	);
}

interface DeleteDialogProps {
	principal: Principal;
	/** The agents that the person sponsors. The server refuses to delete a sponsor. */
	sponsored: readonly Principal[];
	onClose: () => void;
	onDeleted: () => void;
}

function DeleteDialog({ principal, sponsored, onClose, onDeleted }: DeleteDialogProps) {
	if (sponsored.length > 0) {
		return (
			<Dialog title={`${principal.display_name} sponsors agents`} onClose={onClose} className="dialog-small">
				<div className="dialog-body">
					<p>
						{principal.display_name} sponsors {sponsored.map((agent) => agent.display_name).join(", ")}. Give each agent
						a different sponsor with Edit, or delete it. Then delete {principal.display_name}.
					</p>
				</div>
				<div className="dialog-actions">
					<button type="button" className="button button-primary" onClick={onClose} data-autofocus>
						OK
					</button>
				</div>
			</Dialog>
		);
	}
	return (
		<ConfirmDialog
			title={`Delete ${principal.display_name}?`}
			confirmLabel="Delete"
			danger
			onClose={onClose}
			onConfirm={async () => {
				await api.call("directory.delete_principal", { principal_id: principal.id });
				onDeleted();
			}}
		>
			<p>You cannot undo this. To keep the data, archive the account.</p>
			<p>
				{principal.display_name} leaves the directory and each shared mailbox. Each credential stops at once. Mail to{" "}
				{principal.address} is refused, and the address is free for a new account. Nobody can open the old mail and
				files again.
			</p>
		</ConfirmDialog>
	);
}
