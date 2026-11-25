import type { MailOrgSettings } from "@asterra/contracts";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { useToast } from "../../lib/toast.tsx";

/**
 * Admin › Mail: the mail settings of the organization (`mail.update_org_settings`). For now, the default of
 * the Screener. Each mailbox of a person and each team mailbox follows it until the mailbox chooses.
 */
export function MailSettingsCard() {
	const toast = useToast();
	const [settings, setSettings] = useState<MailOrgSettings | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setError(null);
		try {
			setSettings(await api.call("mail.get_org_settings"));
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	async function toggle(enabled: boolean) {
		setBusy(true);
		setError(null);
		try {
			setSettings(await api.call("mail.update_org_settings", { screener: { default_enabled: enabled } }));
			toast({ message: enabled ? "The Screener is on by default." : "The Screener is off by default." });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="panel">
			<div className="panel-heading">
				<p className="panel-intro">The mail settings of your organization.</p>
			</div>
			{settings === null && !error && <p className="panel-card panel-empty">Loading the mail settings…</p>}
			{settings === null && error && (
				<div role="alert">
					<p className="form-error">{error}</p>
					<button type="button" className="button" onClick={() => void load()}>
						Try again
					</button>
				</div>
			)}
			{settings && (
				<div className="panel-card mailbox-settings-card">
					<h2 className="panel-title">The Screener</h2>
					<label className="check-row">
						<input
							type="checkbox"
							className="checkbox"
							checked={settings.screener.default_enabled}
							onChange={() => void toggle(!settings.screener.default_enabled)}
							disabled={busy}
						/>
						<span>
							Use the Screener in each mailbox
							<span className="check-hint">
								The first time a person from outside the organization writes to a mailbox, the mail waits in the
								Screener. A member of the mailbox then screens the sender in or out. The sender is not told. Each
								mailbox can change this in its settings. The Screener is not for the mailboxes of agents.
							</span>
						</span>
					</label>
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
				</div>
			)}
		</section>
	);
}
