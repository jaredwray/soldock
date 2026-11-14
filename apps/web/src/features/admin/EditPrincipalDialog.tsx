import type { InputOf, Principal } from "@soldock/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";

type Role = "admin" | "member";

interface EditPrincipalDialogProps {
	me: Principal;
	principal: Principal;
	/** The people of the directory. An agent can get a sponsor who is not archived. */
	humans: readonly Principal[];
	onClose: () => void;
	onSaved: (principal: Principal) => void;
}

/**
 * Changes the name of a person or an agent, the role of a person, or the sponsor of an agent
 * (`directory.update_principal`). The dialog sends only the fields that changed. Nobody changes their
 * own role or the role of the owner, so the role control is off for them.
 */
export function EditPrincipalDialog({ me, principal, humans, onClose, onSaved }: EditPrincipalDialogProps) {
	const [name, setName] = useState(principal.display_name);
	const [role, setRole] = useState<Role>(principal.org_role === "admin" ? "admin" : "member");
	const [sponsorId, setSponsorId] = useState(principal.sponsor_id ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { name: useId(), role: useId(), roleHint: useId(), sponsor: useId() };
	const isOwner = principal.org_role === "owner";
	const isMe = principal.id === me.id;
	// The current sponsor stays in the list, also when archived, so the control shows the current value.
	const sponsors = humans.filter((human) => human.archived_at === null || human.id === principal.sponsor_id);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return setError("Enter a name.");
		const input: InputOf<"directory.update_principal"> = { principal_id: principal.id };
		if (trimmed !== principal.display_name) input.display_name = trimmed;
		if (principal.kind === "human" && !isOwner && !isMe && role !== principal.org_role) input.org_role = role;
		if (principal.kind === "agent" && sponsorId && sponsorId !== principal.sponsor_id) input.sponsor_id = sponsorId;
		if (Object.keys(input).length === 1) return onClose();
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("directory.update_principal", input);
			onSaved(result.principal);
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog
			title={`Edit ${principal.display_name}`}
			description={principal.address}
			onClose={() => !busy && onClose()}
			className="dialog-small"
		>
			<form onSubmit={submit} noValidate>
				<div className="dialog-body form-stack">
					<div className="field">
						<label htmlFor={ids.name} className="field-label">
							Display name
						</label>
						<input
							id={ids.name}
							className="input"
							value={name}
							maxLength={100}
							onChange={(event) => setName(event.target.value)}
							disabled={busy}
							data-autofocus
						/>
					</div>
					{principal.kind === "human" && (
						<div className="field">
							<label htmlFor={ids.role} className="field-label">
								Role
							</label>
							{isOwner ? (
								<p id={ids.role} className="field-hint">
									Owner. The role of the owner cannot change.
								</p>
							) : (
								<>
									<select
										id={ids.role}
										className="input"
										value={role}
										onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "member")}
										aria-describedby={ids.roleHint}
										disabled={busy || isMe}
									>
										<option value="member">Member</option>
										<option value="admin">Admin</option>
									</select>
									<p id={ids.roleHint} className="field-hint">
										{isMe
											? "You cannot change your own role."
											: "An admin can manage people, agents, shared mailboxes and email domains."}
									</p>
								</>
							)}
						</div>
					)}
					{principal.kind === "agent" && (
						<div className="field">
							<label htmlFor={ids.sponsor} className="field-label">
								Sponsor
							</label>
							<select
								id={ids.sponsor}
								className="input"
								value={sponsorId}
								onChange={(event) => setSponsorId(event.target.value)}
								disabled={busy}
							>
								{sponsors.map((human) => (
									<option key={human.id} value={human.id} disabled={human.archived_at !== null}>
										{human.display_name} ({human.address}){human.archived_at !== null ? ", archived" : ""}
									</option>
								))}
							</select>
						</div>
					)}
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<div className="dialog-actions">
					<button type="button" className="button" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" className="button button-primary" disabled={busy}>
						{busy ? "Saving…" : "Save"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}
