import type { CreatedApiKey, Principal } from "@asterra/contracts";
import { useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { Icon } from "../../lib/icons.tsx";
import { useToast } from "../../lib/toast.tsx";
import { CreatePrincipalDialog } from "./CreatePrincipalForm.tsx";
import { McpEndpointBanner } from "./McpEndpointBanner.tsx";
import { PrincipalCard } from "./PrincipalCard.tsx";

type Action = { kind: "create" } | { kind: "archive" | "delete"; principal: Principal };

interface MembersSectionProps {
	me: Principal;
	/** True for an owner or an admin. A sponsor sees only the agents of that sponsor. */
	elevated: boolean;
	principals: readonly Principal[];
	/** Called after each change, so the page loads the directory again. */
	onChanged: () => void;
	onCreated: (principal: Principal, key: CreatedApiKey) => void;
}

/**
 * The directory: each person and each agent, in one list of cards. An owner or an admin opens a card
 * to change the account. An agent card also has the policy, the connected apps, the webhooks and the
 * API keys. A sponsor who is a member sees only the agents of that sponsor.
 */
export function MembersSection({ me, elevated, principals, onChanged, onCreated }: MembersSectionProps) {
	const toast = useToast();
	const [action, setAction] = useState<Action | null>(null);
	const humans = principals.filter((principal) => principal.kind === "human");
	const listed = listedPrincipals(principals, me, elevated);
	// The server refuses to archive a person who sponsors an agent that is not archived, and to delete a
	// person who sponsors any agent: the person could still act through the keys of the agent.
	const activeAgentsOf = (principal: Principal) =>
		principals.filter((agent) => agent.sponsor_id === principal.id && agent.archived_at === null);

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
		<>
			<McpEndpointBanner />
			<section className="panel">
				<div className="panel-head">
					<p className="panel-heading panel-intro">
						{elevated
							? "The people and agents of the organization. Open a card to change the account. An archived account cannot sign in, and it keeps its mail and files."
							: "Set who each agent can send mail to. Manage its connected apps and its API keys. An agent can never change its own policy."}
					</p>
					{elevated && (
						<button type="button" className="button button-primary" onClick={() => setAction({ kind: "create" })}>
							<Icon name="plus" size={18} />
							New person or agent
						</button>
					)}
				</div>
				{listed.length === 0 && (
					<p className="panel-card panel-empty">
						{elevated ? "There are no people or agents yet." : "There are no agents yet."}
					</p>
				)}
				<div className="admin-card-list">
					{listed.map((principal) => (
						<PrincipalCard
							key={principal.id}
							principal={principal}
							me={me}
							humans={humans}
							elevated={elevated}
							onChanged={onChanged}
							onArchive={() => setAction({ kind: "archive", principal })}
							onRestore={() => void restore(principal)}
							onDelete={() => setAction({ kind: "delete", principal })}
						/>
					))}
				</div>
			</section>
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
			{action?.kind === "archive" && activeAgentsOf(action.principal).length > 0 && (
				<SponsorNotice
					principal={action.principal}
					agents={activeAgentsOf(action.principal)}
					action="archive"
					onClose={() => setAction(null)}
				/>
			)}
			{action?.kind === "archive" && activeAgentsOf(action.principal).length === 0 && (
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
					sponsored={principals.filter((principal) => principal.sponsor_id === action.principal.id)}
					onClose={() => setAction(null)}
					onDeleted={() => {
						toast({ message: `${action.principal.display_name} is deleted.` });
						onChanged();
					}}
				/>
			)}
		</>
	);
}

/** People come first, then agents. Each group is in name order. A sponsor sees only their own agents. */
function listedPrincipals(principals: readonly Principal[], me: Principal, elevated: boolean): Principal[] {
	const visible = elevated
		? principals
		: principals.filter((principal) => principal.kind === "agent" && principal.sponsor_id === me.id);
	return [...visible].sort(
		(a, b) => Number(a.kind === "agent") - Number(b.kind === "agent") || a.display_name.localeCompare(b.display_name),
	);
}

interface DeleteDialogProps {
	principal: Principal;
	/** The agents that the person sponsors. The server refuses to delete a sponsor. */
	sponsored: readonly Principal[];
	onClose: () => void;
	onDeleted: () => void;
}

interface SponsorNoticeProps {
	principal: Principal;
	agents: readonly Principal[];
	action: "archive" | "delete";
	onClose: () => void;
}

/** Tells why a person who sponsors agents cannot be archived or deleted yet, and what to do first. */
function SponsorNotice({ principal, agents, action, onClose }: SponsorNoticeProps) {
	return (
		<Dialog title={`${principal.display_name} sponsors agents`} onClose={onClose} className="dialog-small">
			<div className="dialog-body">
				<p>
					{principal.display_name} sponsors {agents.map((agent) => agent.display_name).join(", ")}. Open each agent and
					give it a different sponsor, or {action} it. Then {action} {principal.display_name}.
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

function DeleteDialog({ principal, sponsored, onClose, onDeleted }: DeleteDialogProps) {
	if (sponsored.length > 0) {
		return <SponsorNotice principal={principal} agents={sponsored} action="delete" onClose={onClose} />;
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
