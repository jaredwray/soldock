import { AliasAddress, MAILBOX_ALIAS_LIMITS, type MailboxAlias } from "@asterra/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Select } from "../../lib/Select.tsx";
import { useToast } from "../../lib/toast.tsx";
import { defaultMailDomain } from "./memberAddress.ts";

interface MailboxAliasesProps {
	/** The id of a principal for its own mailbox, or the id of a team mailbox. */
	mailboxId: string;
	mailboxName: string;
}

/**
 * The aliases of one mailbox, for an owner or an admin: extra addresses that receive mail for the mailbox
 * (`directory.list_mailbox_aliases`, `directory.add_mailbox_alias`, `directory.remove_mailbox_alias`).
 * Mail from the mailbox always uses its primary address. The new alias is a name in a field and a saved mail
 * domain from a list, as in the New member form. The list selects the domain of the primary address first.
 */
export function MailboxAliases({ mailboxId, mailboxName }: MailboxAliasesProps) {
	const toast = useToast();
	const [aliases, setAliases] = useState<MailboxAlias[] | null>(null);
	const [localPart, setLocalPart] = useState("");
	// The saved mail domains: null until they load. The server accepts an alias only on a saved domain.
	const [domains, setDomains] = useState<readonly string[] | null>(null);
	/** The error of the load of the domains. It shows in the form with a Try again button. */
	const [domainsError, setDomainsError] = useState<string | null>(null);
	const [domain, setDomain] = useState("");
	const [busy, setBusy] = useState(false);
	/** The error of the load. It shows above the list. */
	const [error, setError] = useState<string | null>(null);
	/** The error of an add. It shows in the form, and the field refers to it. */
	const [addError, setAddError] = useState<string | null>(null);
	const [remove, setRemove] = useState<string | null>(null);
	const ids = { heading: useId(), input: useId(), hint: useId(), error: useId() };

	const load = useCallback(async () => {
		setError(null);
		const [listed, saved] = await Promise.allSettled([
			api.call("directory.list_mailbox_aliases", { mailbox_id: mailboxId }),
			api.call("directory.list_mail_domains"),
		]);
		if (listed.status === "rejected") return setError(errorMessage(listed.reason));
		setAliases(listed.value.aliases);
		if (saved.status === "rejected") return setDomainsError(errorMessage(saved.reason));
		setDomainsError(null);
		setDomains(saved.value.mail_domains);
		setDomain(defaultMailDomain(saved.value.mail_domains, listed.value.address));
	}, [mailboxId]);

	useEffect(() => {
		void load();
	}, [load]);

	/** Loads the aliases and the domains again, after the domains did not load. The error stays until they load. */
	async function retry() {
		setBusy(true);
		try {
			await load();
		} finally {
			setBusy(false);
		}
	}

	async function add(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const local = localPart.trim();
		if (!local) return setAddError("Enter the part of the alias before @.");
		if (local.includes("@")) return setAddError("Enter only the part before @. Select the domain from the list.");
		const parsed = AliasAddress.safeParse(`${local}@${domain}`);
		if (!parsed.success) {
			return setAddError("Use only letters, digits, dots, hyphens and underscores before the @.");
		}
		setBusy(true);
		setAddError(null);
		try {
			const result = await api.call("directory.add_mailbox_alias", { mailbox_id: mailboxId, address: parsed.data });
			setAliases(result.aliases);
			setLocalPart("");
			toast({ message: `${parsed.data} now receives mail for ${mailboxName}.` });
		} catch (caught) {
			setAddError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function removeAlias(value: string) {
		setBusy(true);
		try {
			const result = await api.call("directory.remove_mailbox_alias", { mailbox_id: mailboxId, address: value });
			setAliases(result.aliases);
			toast({ message: `${value} removed.` });
		} finally {
			setBusy(false);
		}
	}

	const full = aliases !== null && aliases.length >= MAILBOX_ALIAS_LIMITS.aliases;
	const noDomains = domains !== null && domains.length === 0;
	// At the limit, the hint shows the limit, not the error of the domains.
	const domainsFailed = !full && domainsError !== null;
	const describedBy = addError ? `${ids.hint} ${ids.error}` : ids.hint;

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
							<div className="address-row">
								<input
									id={ids.input}
									className="input"
									autoComplete="off"
									autoCapitalize="none"
									spellCheck={false}
									placeholder="sales"
									maxLength={64}
									value={localPart}
									onChange={(event) => setLocalPart(event.target.value)}
									aria-invalid={addError ? true : undefined}
									aria-describedby={describedBy}
									disabled={busy || full || noDomains}
								/>
								<span className="address-at" aria-hidden="true">
									@
								</span>
								<Select
									label="Email domain of the alias"
									className="input address-domain-select"
									value={domain}
									options={(domains ?? []).map((value) => ({ value, label: value }))}
									onChange={setDomain}
									placeholder={domains === null ? "Not available" : "No domains"}
									disabled={busy || full || !domains?.length}
									aria-describedby={describedBy}
								/>
							</div>
							<p
								id={ids.hint}
								className={domainsFailed ? "form-error" : "field-hint"}
								role={domainsFailed ? "alert" : undefined}
							>
								{full
									? `A mailbox can have at most ${MAILBOX_ALIAS_LIMITS.aliases} aliases.`
									: domainsError
										? `The email domains did not load. ${domainsError}`
										: noDomains
											? "There are no email domains yet. Add one in Admin › Email domains."
											: "Select a saved email domain. Mail to the alias arrives at once."}
							</p>
							{domainsFailed && (
								<div>
									<button type="button" className="button" onClick={() => void retry()} disabled={busy}>
										Try again
									</button>
								</div>
							)}
						</div>
						{addError && (
							<p id={ids.error} className="form-error" role="alert">
								{addError}
							</p>
						)}
						<button type="submit" className="button button-primary" disabled={busy || full || !domain}>
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
