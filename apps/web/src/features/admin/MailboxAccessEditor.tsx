import { MAILBOX_MEMBER_SCOPES, type MailboxMemberScope, type Principal } from "@asterra/contracts";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { actorKind, KIND_NAMES } from "../../lib/principalKind.ts";
import { Select } from "../../lib/Select.tsx";
import { useToast } from "../../lib/toast.tsx";
import { principalOption } from "../../lib/usePrincipals.ts";
import { MAILBOX_SCOPE_NAMES, memberScopes, scopesText, toggleMemberScope } from "./mailboxScopes.ts";

/** Sorts people and agents by name. */
export function byName(a: Principal, b: Principal): number {
	return a.display_name.localeCompare(b.display_name);
}

/** The words of the editor. A shared mailbox has members, and the own mailbox of a person has delegates. */
export interface AccessEditorText {
	/** The caption of the table, for a screen reader. */
	caption: (mailbox: string) => string;
	/** The text of a mailbox that nobody else can use. */
	empty: string;
	/** The label of the control that selects a new principal. */
	addLabel: string;
	/** The hint under that control. */
	addHint: string;
	/** The hint when the list has the most principals that it can have. */
	full: string;
	/** The legend of the scopes of a new principal. */
	newLegend: string;
	/** The hint under those scopes. */
	scopesHint: string;
	addButton: string;
	/** The name of the Remove button of one principal, for a screen reader. */
	removeLabel: (member: string, mailbox: string) => string;
	removeTitle: string;
	removeConfirm: string;
	removeBody: (member: string, mailbox: string) => string;
}

interface MailboxAccessEditorProps {
	heading: string;
	/** The name of the mailbox in the texts: its display name, or "your mailbox". */
	mailboxName: string;
	/** Each principal that can use the mailbox, with its scopes there. */
	members: readonly { principal_id: string; scopes: readonly string[] }[];
	principals: readonly Principal[];
	/** The principals that the editor never offers, for example the owner of the mailbox. */
	exclude?: readonly string[];
	/** The most principals that the list can have. */
	limit: number;
	text: AccessEditorText;
	/** A line under the form, for example about a different way to share mail. */
	note?: ReactNode;
	/** Adds a principal with these scopes, or gives a principal these scopes. It throws when the call fails. */
	onSet: (principal: Principal, scopes: MailboxMemberScope[]) => Promise<void>;
	/** Removes the access of a principal. It throws when the call fails. */
	onRemove: (principal: Principal) => Promise<void>;
}

/**
 * Who can use a mailbox, with what each one can do in it: a table with the scopes of each principal, a
 * control to add one and a button to remove each one. The scopes are the same for a person, an agent and a
 * service account. The members of a shared mailbox and the delegates of the own mailbox of a person use it.
 */
export function MailboxAccessEditor({
	heading,
	mailboxName,
	members: stored,
	principals,
	exclude = [],
	limit,
	text,
	note,
	onSet,
	onRemove,
}: MailboxAccessEditorProps) {
	const toast = useToast();
	const [candidateId, setCandidateId] = useState("");
	const [newScopes, setNewScopes] = useState<MailboxMemberScope[]>([...MAILBOX_MEMBER_SCOPES]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [removing, setRemoving] = useState<Principal | null>(null);
	const ids = { heading: useId(), select: useId(), hint: useId(), scopes: useId() };
	const memberIds = stored.map((member) => member.principal_id);
	const members = stored.flatMap((member) =>
		principals
			.filter((principal) => principal.id === member.principal_id)
			.map((principal) => ({ principal, scopes: memberScopes(member.scopes) })),
	);

	/** Sets what a principal can do in the mailbox. The change applies at the next call of the principal. */
	async function set(principal: Principal, scopes: MailboxMemberScope[], added: boolean) {
		setBusy(true);
		setError(null);
		try {
			await onSet(principal, scopes);
			if (added) {
				setCandidateId("");
				setNewScopes([...MAILBOX_MEMBER_SCOPES]);
			}
			toast({ message: `${principal.display_name} can now ${scopesText(scopes)} in ${mailboxName}.` });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}
	// An archived account cannot use a mailbox, so the list does not offer it.
	const candidates = principals
		.filter(
			(principal) =>
				!memberIds.includes(principal.id) && !exclude.includes(principal.id) && principal.archived_at === null,
		)
		.sort(byName);
	const full = memberIds.length >= limit;

	function add(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const principal = candidates.find((candidate) => candidate.id === candidateId);
		if (!principal) return setError("Select a person or an agent.");
		void set(principal, newScopes, true);
	}

	async function remove(principal: Principal) {
		await onRemove(principal);
		toast({ message: `${principal.display_name} can no longer use ${mailboxName}.` });
	}

	return (
		<section className="panel" aria-labelledby={ids.heading}>
			<h2 id={ids.heading} className="panel-title">
				{heading}
			</h2>
			<div className="panel-card panel-card-list">
				{members.length === 0 ? (
					<p className="panel-empty">{text.empty}</p>
				) : (
					<div className="table-scroll">
						<table className="table table-rows">
							<caption className="visually-hidden">{text.caption(mailboxName)}</caption>
							<thead>
								<tr>
									<th scope="col">Name</th>
									<th scope="col">Kind</th>
									<th scope="col">Can</th>
									<th scope="col" className="cell-actions">
										<span className="visually-hidden">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{members.map(({ principal: member, scopes }) => (
									<tr key={member.id} className={member.archived_at !== null ? "row-muted" : undefined}>
										<td>
											<div className="member-name">
												{member.display_name}
												{member.archived_at !== null && <span className="chip chip-small">Archived</span>}
											</div>
											<div className="row-note">{member.address}</div>
										</td>
										<td>
											<span className={`kind kind-${actorKind(member.kind)}`}>{KIND_NAMES[member.kind]}</span>
										</td>
										<td>
											<fieldset className="scope-inline">
												<legend className="visually-hidden">
													What {member.display_name} can do in {mailboxName}
												</legend>
												{MAILBOX_MEMBER_SCOPES.map((scope) => {
													const next = toggleMemberScope(scopes, scope);
													return (
														<label key={scope} className="check-row check-row-inline">
															<input
																type="checkbox"
																className="checkbox"
																checked={scopes.includes(scope)}
																onChange={() => next && void set(member, next, false)}
																// A principal keeps one scope. Remove takes the access away.
																disabled={busy || next === null}
															/>
															<span>{MAILBOX_SCOPE_NAMES[scope]}</span>
														</label>
													);
												})}
											</fieldset>
										</td>
										<td className="cell-actions">
											<button
												type="button"
												className="button button-small"
												aria-label={text.removeLabel(member.display_name, mailboxName)}
												onClick={() => setRemoving(member)}
												disabled={busy}
											>
												Remove
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				<form className="panel-form panel-form-divided" onSubmit={add} noValidate>
					<div className="field">
						<label htmlFor={ids.select} className="field-label">
							{text.addLabel}
						</label>
						<Select
							id={ids.select}
							value={candidateId}
							options={candidates.map(principalOption)}
							placeholder="Select a person or an agent"
							onChange={setCandidateId}
							aria-describedby={ids.hint}
							disabled={busy || full || candidates.length === 0}
						/>
						<p id={ids.hint} className="field-hint">
							{full ? text.full : text.addHint}
						</p>
					</div>
					<fieldset className="scope-inline" aria-describedby={ids.scopes}>
						<legend className="field-label">{text.newLegend}</legend>
						{MAILBOX_MEMBER_SCOPES.map((scope) => {
							const next = toggleMemberScope(newScopes, scope);
							return (
								<label key={scope} className="check-row check-row-inline">
									<input
										type="checkbox"
										className="checkbox"
										checked={newScopes.includes(scope)}
										onChange={() => next && setNewScopes(next)}
										disabled={busy || full || next === null}
									/>
									<span>{MAILBOX_SCOPE_NAMES[scope]}</span>
								</label>
							);
						})}
						<p id={ids.scopes} className="field-hint">
							{text.scopesHint}
						</p>
					</fieldset>
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
					<button type="submit" className="button button-primary" disabled={busy || full || candidates.length === 0}>
						{busy ? "Please wait…" : text.addButton}
					</button>
					{note && <p className="field-hint">{note}</p>}
				</form>
			</div>
			{removing && (
				<ConfirmDialog
					title={text.removeTitle}
					confirmLabel={text.removeConfirm}
					danger
					onClose={() => setRemoving(null)}
					onConfirm={() => remove(removing)}
				>
					<p>{text.removeBody(removing.display_name, mailboxName)}</p>
				</ConfirmDialog>
			)}
		</section>
	);
}
