import { AddressFormat, addressLocalPart, type InputOf, type MailOrgSettings } from "@asterra/contracts";
import { useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { useToast } from "../../lib/toast.tsx";

/** The name that shows each address format as an example. */
const EXAMPLE_NAME = "Ada Lovelace";

/**
 * Admin › Mail: the mail settings of the organization (`mail.update_org_settings`). The default of the
 * Screener: each mailbox of a person and each team mailbox follows it until the mailbox chooses. The address
 * format: the New member form fills in the address of a new person from the display name in this format.
 */
export function MailSettingsCard() {
	const toast = useToast();
	const [settings, setSettings] = useState<MailOrgSettings | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const formatName = useId();

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

	async function update(change: InputOf<"mail.update_org_settings">, message: string) {
		setBusy(true);
		setError(null);
		try {
			setSettings(await api.call("mail.update_org_settings", change));
			toast({ message });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	function toggle(enabled: boolean) {
		void update(
			{ screener: { default_enabled: enabled } },
			enabled ? "The Screener is on by default." : "The Screener is off by default.",
		);
	}

	function changeFormat(enabled: boolean, format: AddressFormat) {
		void update(
			{ address_format: { enabled, format } },
			enabled
				? `The address of a new person is now ${addressLocalPart(EXAMPLE_NAME, format)} for ${EXAMPLE_NAME}.`
				: "The address format is off.",
		);
	}

	const errorAlert = error && (
		<p className="form-error" role="alert">
			{error}
		</p>
	);

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
				<>
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
					</div>
					<div className="panel-card mailbox-settings-card">
						<h2 className="panel-title">Address format</h2>
						<label className="check-row">
							<input
								type="checkbox"
								className="checkbox"
								checked={settings.address_format.enabled}
								onChange={() => changeFormat(!settings.address_format.enabled, settings.address_format.format)}
								disabled={busy}
							/>
							<span>
								Fill in the address of a new person
								<span className="check-hint">
									In New member, the address of a person follows the display name in this format. You can change the
									address before you create the person. Agents and service accounts do not use the format.
								</span>
							</span>
						</label>
						{settings.address_format.enabled && (
							<fieldset className="segmented">
								<legend className="field-label">The address for {EXAMPLE_NAME}</legend>
								{AddressFormat.options.map((format) => (
									<label
										key={format}
										className={settings.address_format.format === format ? "segment segment-active" : "segment"}
									>
										<input
											type="radio"
											name={formatName}
											value={format}
											checked={settings.address_format.format === format}
											onChange={() => changeFormat(true, format)}
											disabled={busy}
										/>
										{addressLocalPart(EXAMPLE_NAME, format)}
									</label>
								))}
							</fieldset>
						)}
					</div>
					{errorAlert}
				</>
			)}
		</section>
	);
}
