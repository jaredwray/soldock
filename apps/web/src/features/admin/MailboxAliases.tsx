import { AliasAddress, MAILBOX_ALIAS_LIMITS, type MailboxAlias } from "@asterra/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { useToast } from "../../lib/toast.tsx";

interface MailboxAliasesProps {
	/** The id of a principal for its own mailbox, or the id of a team mailbox. */
	mailboxId: string;
	mailboxName: string;
}

/**
 * The aliases of one mailbox, for an owner or an admin: extra addresses that receive mail for the mailbox
 * (`directory.list_mailbox_aliases`, `directory.add_mailbox_alias`, `directory.remove_mailbox_alias`).
 * Mail from the mailbox always uses its primary address.
 */
export function MailboxAliases({ mailboxId, mailboxName }: MailboxAliasesProps) {
	const toast = useToast();
	const [aliases, setAliases] = useState<MailboxAlias[] | null>(null);
	const [address, setAddress] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [remove, setRemove] = useState<string | null>(null);
	const ids = { heading: useId(), input: useId(), hint: useId() };

	const load = useCallback(async () => {
		setError(null);
		try {
			setAliases((await api.call("directory.list_mailbox_aliases", { mailbox_id: mailboxId })).aliases);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [mailboxId]);

	useEffect(() => {
		void load();
	}, [load]);

	async function add(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const parsed = AliasAddress.safeParse(address);
		if (!parsed.success) {
			return setError(
				"Enter one address, such as sales@example.com. Use only letters, digits, dots, hyphens and underscores before the @.",
			);
		}
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("directory.add_mailbox_alias", { mailbox_id: mailboxId, address: parsed.data });
			setAliases(result.aliases);
			setAddress("");
			toast({ message: `${parsed.data} now receives mail for ${mailboxName}.` });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function removeAlias(value: string) {
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("directory.remove_mailbox_alias", { mailbox_id: mailboxId, address: value });
			setAliases(result.aliases);
			toast({ message: `${value} removed.` });
		} finally {
			setBusy(false);
		}
	}

	const full = aliases !== null && aliases.length >= MAILBOX_ALIAS_LIMITS.aliases;

	return (
		<section className="panel" aria-labelledby={ids.heading}>
			<h2 id={ids.heading} className="panel-title">
				Aliases
			</h2>
			<p className="field-hint">
				An alias is an extra address that receives mail for {mailboxName}. Mail from the mailbox always uses its primary
				address.
			</p>
			{aliases === null && !error && <p className="panel-card panel-empty">Loading aliases…</p>}
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			{aliases === null && error && (
				<div>
					<button type="button" className="button" onClick={() => void load()}>
						Try again
					</button>
				</div>
			)}
			{aliases !== null && (
				<>
					<div className="panel-card panel-card-list">
						{aliases.length === 0 ? (
							<p className="panel-empty">This mailbox has no aliases.</p>
						) : (
							<div className="table-scroll">
								<table className="table table-rows">
									<caption className="visually-hidden">Aliases of {mailboxName}</caption>
									<thead>
										<tr>
											<th scope="col">Address</th>
											<th scope="col" className="cell-actions">
												<span className="visually-hidden">Actions</span>
											</th>
										</tr>
									</thead>
									<tbody>
										{aliases.map((alias) => (
											<tr key={alias.address}>
												<td className="cell-address row-title">{alias.address}</td>
												<td className="cell-actions">
													<button
														type="button"
														className="button button-small"
														aria-label={`Remove ${alias.address}`}
														onClick={() => setRemove(alias.address)}
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
					</div>
					<form className="panel-card panel-form" onSubmit={add} noValidate>
						<div className="field">
							<label htmlFor={ids.input} className="field-label">
								New alias
							</label>
							<input
								id={ids.input}
								className="input"
								type="email"
								autoComplete="off"
								autoCapitalize="none"
								spellCheck={false}
								placeholder="sales@example.com"
								value={address}
								onChange={(event) => setAddress(event.target.value)}
								aria-describedby={ids.hint}
								disabled={busy || full}
							/>
							<p id={ids.hint} className="field-hint">
								{full
									? `A mailbox can have at most ${MAILBOX_ALIAS_LIMITS.aliases} aliases.`
									: "Use a saved email domain. Mail to the alias arrives at once."}
							</p>
						</div>
						<button type="submit" className="button button-primary" disabled={busy || full}>
							{busy ? "Please wait…" : "Add alias"}
						</button>
					</form>
				</>
			)}
			{remove && (
				<ConfirmDialog
					title="Remove alias?"
					confirmLabel="Remove alias"
					danger
					onClose={() => setRemove(null)}
					onConfirm={() => removeAlias(remove)}
				>
					<p>
						Remove {remove} from {mailboxName}? New mail to it is rejected at once. The mail that it received stays in
						the mailbox.
					</p>
				</ConfirmDialog>
			)}
		</section>
	);
}
