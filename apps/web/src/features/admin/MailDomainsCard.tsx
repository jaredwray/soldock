import { MailDomain } from "@soldock/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { useToast } from "../../lib/toast.tsx";

export function MailDomainsCard() {
	const [domains, setDomains] = useState<string[] | null>(null);
	const [domain, setDomain] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [remove, setRemove] = useState<string | null>(null);
	const inputId = useId();
	const hintId = useId();
	const toast = useToast();

	const load = useCallback(async () => {
		setError(null);
		try {
			setDomains((await api.call("directory.list_mail_domains")).mail_domains);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	async function add(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const parsed = MailDomain.safeParse(domain);
		if (!parsed.success) return setError("Enter a domain such as example.com, without https:// or an email address.");
		setBusy(true);
		setError(null);
		try {
			setDomains((await api.call("directory.add_mail_domain", { domain: parsed.data })).mail_domains);
			setDomain("");
			toast({ message: "Email domain saved." });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function removeDomain(value: string) {
		setBusy(true);
		setError(null);
		try {
			setDomains((await api.call("directory.remove_mail_domain", { domain: value })).mail_domains);
			toast({ message: "Email domain removed." });
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="card">
			<p className="muted">
				Manage the domains for your email addresses. Changes take effect without a new deployment.
			</p>
			<p className="field-hint">
				For each domain, configure Cloudflare Email Routing to this Worker. Verify the domain in Cloudflare Email
				Service. Publish the DNS records that Cloudflare provides. A saved domain does not confirm that mail delivery is
				ready.
			</p>
			{domains === null && !error && <p className="muted">Loading email domains…</p>}
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			{domains === null && error && (
				<button type="button" className="button" onClick={() => void load()}>
					Try again
				</button>
			)}
			{domains !== null && (
				<>
					<div className="table-scroll">
						<table className="table">
							<caption className="visually-hidden">Saved email domains</caption>
							<thead>
								<tr>
									<th scope="col">Domain</th>
									<th scope="col">Action</th>
								</tr>
							</thead>
							<tbody>
								{domains.map((value) => (
									<tr key={value}>
										<td className="cell-address">{value}</td>
										<td>
											<button
												type="button"
												className="button"
												aria-label={`Remove ${value}`}
												onClick={() => setRemove(value)}
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
					{domains.length === 0 && <p className="muted">There are no email domains yet.</p>}
					<p className="field-hint">You cannot remove a domain with mailbox addresses.</p>
					<form className="create-key" onSubmit={add} noValidate>
						<div className="field">
							<label htmlFor={inputId} className="field-label">
								New email domain
							</label>
							<input
								id={inputId}
								className="input"
								type="text"
								autoComplete="off"
								autoCapitalize="none"
								spellCheck={false}
								placeholder="example.com"
								value={domain}
								onChange={(event) => setDomain(event.target.value)}
								aria-describedby={hintId}
								disabled={busy}
							/>
							<p id={hintId} className="field-hint">
								Use a domain you own, such as example.com.
							</p>
						</div>
						<button type="submit" className="button button-primary" disabled={busy}>
							{busy ? "Please wait…" : "Add domain"}
						</button>
					</form>
				</>
			)}
			{remove && (
				<ConfirmDialog
					title="Remove email domain?"
					confirmLabel="Remove domain"
					danger
					onClose={() => setRemove(null)}
					onConfirm={() => removeDomain(remove)}
				>
					<p>Remove {remove} from Soldock? Cloudflare and DNS records stay in place.</p>
				</ConfirmDialog>
			)}
		</div>
	);
}
