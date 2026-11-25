import type { Principal } from "@asterra/contracts";
import { useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { useToast } from "../../lib/toast.tsx";

interface MemberAccountProps {
	principal: Principal;
	/** The whole directory. The server refuses to archive or delete a person who still sponsors an account. */
	principals: readonly Principal[];
	/** Called after an archive or a restore, so the page loads the directory again. */
	onChanged: () => void;
	/** Called after a delete. The page of the account then goes back to the list. */
	onDeleted: () => void;
}

/**
 * The Account part of the page of a member: Archive or Restore, and Delete. Archive and Delete ask for a
 * confirmation. For a person who sponsors agents or service accounts, a notice names them first.
 */
export function MemberAccount({ principal, principals, onChanged, onDeleted }: MemberAccountProps) {
	const toast = useToast();
	const [action, setAction] = useState<"archive" | "delete" | null>(null);
	const archived = principal.archived_at !== null;
	const isService = principal.kind === "service";
	// The server refuses to archive a person who sponsors an agent or a service account that is not
	// archived, and to delete a person who sponsors any: the person could still act through its keys.
	const sponsored = principals.filter((account) => account.sponsor_id === principal.id);
	const activeSponsored = sponsored.filter((account) => account.archived_at === null);

	async function restore() {
		try {
			await api.call("directory.restore_principal", { principal_id: principal.id });
			toast({ message: `${principal.display_name} is restored.` });
			onChanged();
		} catch (caught) {
			toast({ message: `${principal.display_name} was not restored. ${errorMessage(caught)}`, tone: "error" });
		}
	}

	return (
		<div className="member-account">
			<h2 className="subpanel-title">Account</h2>
			<p className="field-hint">
				{isService
					? "Archive stops each token. The mail and the files stay. Delete removes the account and revokes its tokens."
					: "Archive stops sign-in and each key. The mail and the files stay. Delete removes the account."}
			</p>
			<div className="admin-card-actions">
				{archived ? (
					<button
						type="button"
						className="button"
						aria-label={`Restore ${principal.display_name}`}
						onClick={() => void restore()}
					>
						Restore
					</button>
				) : (
					<button
						type="button"
						className="button"
						aria-label={`Archive ${principal.display_name}`}
						onClick={() => setAction("archive")}
					>
						Archive
					</button>
				)}
				<button
					type="button"
					className="button button-danger"
					aria-label={`Delete ${principal.display_name}`}
					onClick={() => setAction("delete")}
				>
					Delete
				</button>
			</div>
			{action === "archive" && activeSponsored.length > 0 && (
				<SponsorNotice
					principal={principal}
					agents={activeSponsored}
					action="archive"
					onClose={() => setAction(null)}
				/>
			)}
			{action === "archive" && activeSponsored.length === 0 && (
				<ConfirmDialog
					title={`Archive ${principal.display_name}?`}
					confirmLabel="Archive"
					danger
					onClose={() => setAction(null)}
					onConfirm={async () => {
						await api.call("directory.archive_principal", { principal_id: principal.id });
						toast({ message: `${principal.display_name} is archived.` });
						onChanged();
					}}
				>
					<p>
						{isService
							? "Each token of the service account stops working at once."
							: `${principal.kind === "agent" ? "The agent" : "They"} cannot sign in, and each API key and connected app stops working at once. Each open session ends.`}
					</p>
					<p>
						The mail, the files and the chat stay, and mail to {principal.address} still arrives. You can restore the
						account later.
					</p>
				</ConfirmDialog>
			)}
			{action === "delete" && sponsored.length > 0 && (
				<SponsorNotice principal={principal} agents={sponsored} action="delete" onClose={() => setAction(null)} />
			)}
			{action === "delete" && sponsored.length === 0 && (
				<ConfirmDialog
					title={`Delete ${principal.display_name}?`}
					confirmLabel="Delete"
					danger
					onClose={() => setAction(null)}
					onConfirm={async () => {
						await api.call("directory.delete_principal", { principal_id: principal.id });
						toast({ message: `${principal.display_name} is deleted.` });
						onDeleted();
					}}
				>
					<p>You cannot undo this. To keep the data, archive the account.</p>
					<p>
						{principal.display_name} leaves the directory and each shared mailbox. Each credential stops at once. Mail
						to {principal.address} is refused, and the address is free for a new account. Nobody can open the old mail
						and files again.
					</p>
				</ConfirmDialog>
			)}
		</div>
	);
}

interface SponsorNoticeProps {
	principal: Principal;
	agents: readonly Principal[];
	action: "archive" | "delete";
	onClose: () => void;
}

/**
 * Tells why a person who sponsors agents or service accounts cannot be archived or deleted yet, and what
 * to do first.
 */
function SponsorNotice({ principal, agents, action, onClose }: SponsorNoticeProps) {
	return (
		<Dialog title={`${principal.display_name} is a sponsor`} onClose={onClose} className="dialog-small">
			<div className="dialog-body">
				<p>
					{principal.display_name} sponsors {agents.map((agent) => agent.display_name).join(", ")}. Open each one and
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
