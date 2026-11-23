import { AUTO_LABEL_LIMITS, type AutoLabelSettings, type InputOf } from "@asterra/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { Icon } from "../../lib/icons.tsx";
import { useToast } from "../../lib/toast.tsx";
import { unavailableText } from "./autoLabels.ts";
import { mailboxInput, useMailboxId } from "./mailbox.tsx";

type LabelEntry = NonNullable<InputOf<"mail.update_auto_labels">["labels"]>[number];

interface AutoLabelsDialogProps {
	/** True for a team mailbox: the members share the settings. */
	team: boolean;
	onClose: () => void;
	/** Called after a change that can change the labels of the mailbox. */
	onChanged: () => void;
}

/**
 * The auto labels of the open mailbox: on or off, each built-in label, the custom labels, and a run on
 * the recent inbox mail. Each change saves at once.
 */
export function AutoLabelsDialog({ team, onClose, onChanged }: AutoLabelsDialogProps) {
	const mailboxId = useMailboxId();
	const toast = useToast();
	const [settings, setSettings] = useState<AutoLabelSettings | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [run, setRun] = useState<{ count: number } | null>(null);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [skipInbox, setSkipInbox] = useState(false);
	const ids = { builtin: useId(), custom: useId(), name: useId(), description: useId(), descriptionHint: useId() };

	const load = useCallback(async () => {
		setError(null);
		try {
			setSettings(await api.call("mail.get_auto_labels", mailboxInput(mailboxId)));
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [mailboxId]);

	useEffect(() => {
		void load();
	}, [load]);

	async function update(change: { enabled?: boolean; labels?: LabelEntry[] }) {
		setBusy(true);
		setError(null);
		try {
			setSettings(await api.call("mail.update_auto_labels", { ...mailboxInput(mailboxId), ...change }));
			onChanged();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function create(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!name.trim()) return setError("Enter a name for the label.");
		if (description.trim().length < AUTO_LABEL_LIMITS.descriptionMinChars) {
			return setError(`Describe the mail in at least ${AUTO_LABEL_LIMITS.descriptionMinChars} characters.`);
		}
		setBusy(true);
		setError(null);
		try {
			setSettings(
				await api.call("mail.create_auto_label", {
					...mailboxInput(mailboxId),
					name: name.trim(),
					description: description.trim(),
					skip_inbox: skipInbox,
				}),
			);
			setName("");
			setDescription("");
			setSkipInbox(false);
			onChanged();
			toast({ message: `Auto label “${name.trim()}” created.` });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function remove(key: string, label: string) {
		setBusy(true);
		setError(null);
		try {
			await api.call("mail.delete_auto_label", { ...mailboxInput(mailboxId), auto_label_id: key });
			await load();
			toast({ message: `Auto label “${label}” deleted. The label and its mail stay.` });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function startRun(dryRun: boolean) {
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("mail.run_auto_labels", { ...mailboxInput(mailboxId), dry_run: dryRun });
			if (dryRun) {
				setRun({ count: result.messages });
			} else {
				setRun(null);
				onChanged();
				toast({
					message:
						`Auto labels examined ${result.messages} messages. ${result.queued > 0 ? "The classifier labels the rest in the next minutes." : ""}`.trim(),
				});
			}
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	const builtins = settings?.labels.filter((label) => label.kind === "builtin") ?? [];
	const customs = settings?.labels.filter((label) => label.kind === "custom") ?? [];
	const unavailable = settings ? unavailableText(settings) : null;

	return (
		<Dialog
			title="Auto labels"
			description={
				team
					? "Sort new mail with labels. The members of this shared mailbox share these settings."
					: "Sort new mail with labels, and keep the inbox for the mail that needs you."
			}
			onClose={onClose}
			className="dialog-wide"
		>
			<div className="dialog-body auto-labels">
				{!settings && !error && <p className="panel-empty">Loading the auto labels…</p>}
				{!settings && error && (
					<div role="alert">
						<p className="form-error">{error}</p>
						<button type="button" className="button" onClick={() => void load()}>
							Try again
						</button>
					</div>
				)}
				{settings && (
					<>
						{unavailable && (
							<p className="notice notice-warning" role="status">
								<Icon name="info" size={16} className="notice-icon" />
								<span>{unavailable}</span>
							</p>
						)}
						<label className="check-row auto-labels-master">
							<input
								type="checkbox"
								className="checkbox"
								checked={settings.enabled}
								onChange={() => void update({ enabled: !settings.enabled })}
								disabled={busy}
								data-autofocus
							/>
							<span>
								Use auto labels in this mailbox
								<span className="check-hint">
									Rules from the mail headers apply first. A Workers AI model decides the rest. Remove a wrong label or
									add the right one, and auto labels learn from it.
								</span>
							</span>
						</label>

						{settings.enabled && (
							<>
								<section className="dialog-section" aria-labelledby={ids.builtin}>
									<h3 id={ids.builtin} className="dialog-section-title">
										Built-in labels
									</h3>
									<p className="field-hint">
										Mail skips the inbox only when its sender is proved: mail from your organization, or mail that
										passed DMARC. Other mail keeps its label and stays in the inbox.
									</p>
									<ul className="auto-label-list">
										{builtins.map((label) => (
											<li key={label.key} className="auto-label-row">
												<label className="check-row">
													<input
														type="checkbox"
														className="checkbox"
														checked={label.enabled}
														onChange={() => void update({ labels: [{ key: label.key, enabled: !label.enabled }] })}
														disabled={busy}
													/>
													<span>
														{label.name}
														<span className="check-hint">{label.description}</span>
													</span>
												</label>
												<label className="check-row auto-label-skip">
													<input
														type="checkbox"
														className="checkbox"
														checked={label.skip_inbox}
														onChange={() =>
															void update({
																labels: [{ key: label.key, enabled: true, skip_inbox: !label.skip_inbox }],
															})
														}
														disabled={busy || !label.enabled}
													/>
													<span>Skip the inbox</span>
												</label>
											</li>
										))}
									</ul>
								</section>

								<section className="dialog-section" aria-labelledby={ids.custom}>
									<h3 id={ids.custom} className="dialog-section-title">
										Your labels
									</h3>
									{customs.length === 0 && (
										<p className="field-hint">
											Describe a kind of mail in plain words, and auto labels give it your label. For example:
											“Investors: monthly updates from the companies that we invested in”.
										</p>
									)}
									{customs.length > 0 && (
										<ul className="auto-label-list">
											{customs.map((label) => (
												<li key={label.key} className="auto-label-row">
													<label className="check-row">
														<input
															type="checkbox"
															className="checkbox"
															checked={label.enabled}
															onChange={() => void update({ labels: [{ key: label.key, enabled: !label.enabled }] })}
															disabled={busy}
														/>
														<span>
															{label.name}
															<span className="check-hint">{label.description}</span>
														</span>
													</label>
													<label className="check-row auto-label-skip">
														<input
															type="checkbox"
															className="checkbox"
															checked={label.skip_inbox}
															onChange={() =>
																void update({ labels: [{ key: label.key, skip_inbox: !label.skip_inbox }] })
															}
															disabled={busy}
														/>
														<span>Skip the inbox</span>
													</label>
													<button
														type="button"
														className="button button-small"
														onClick={() => void remove(label.key, label.name)}
														disabled={busy}
														aria-label={`Delete the auto label ${label.name}`}
													>
														Delete
													</button>
												</li>
											))}
										</ul>
									)}
									{customs.length < AUTO_LABEL_LIMITS.custom ? (
										<form className="auto-label-form" onSubmit={create} noValidate>
											<div className="field">
												<label htmlFor={ids.name} className="field-label">
													Label name
												</label>
												<input
													id={ids.name}
													className="input"
													value={name}
													maxLength={AUTO_LABEL_LIMITS.nameChars}
													onChange={(event) => setName(event.target.value)}
													disabled={busy}
												/>
											</div>
											<div className="field">
												<label htmlFor={ids.description} className="field-label">
													Which mail gets it
												</label>
												<textarea
													id={ids.description}
													className="input"
													rows={2}
													value={description}
													maxLength={AUTO_LABEL_LIMITS.descriptionChars}
													onChange={(event) => setDescription(event.target.value)}
													aria-describedby={ids.descriptionHint}
													disabled={busy}
												/>
												<p id={ids.descriptionHint} className="field-hint">
													The classifier reads this text. Name the senders or the topic.
												</p>
											</div>
											<label className="check-row">
												<input
													type="checkbox"
													className="checkbox"
													checked={skipInbox}
													onChange={() => setSkipInbox(!skipInbox)}
													disabled={busy}
												/>
												<span>Skip the inbox</span>
											</label>
											<button type="submit" className="button" disabled={busy}>
												Add label
											</button>
										</form>
									) : (
										<p className="field-hint">
											A mailbox can have at most {AUTO_LABEL_LIMITS.custom} labels of its own.
										</p>
									)}
								</section>

								<section className="dialog-section">
									<h3 className="dialog-section-title">Recent mail</h3>
									{run === null ? (
										<>
											<p className="field-hint">
												Apply auto labels to the last {AUTO_LABEL_LIMITS.runDefault} messages in the inbox. Mail stays
												in the inbox.
											</p>
											<button
												type="button"
												className="button"
												onClick={() => void startRun(true)}
												disabled={busy || !settings.available}
											>
												Label recent inbox mail
											</button>
										</>
									) : (
										<div className="auto-label-run">
											<p>
												{run.count === 0
													? "No inbox mail waits for auto labels."
													: `Auto labels will examine ${run.count} messages. The model calls count toward the AI budget of your organization.`}
											</p>
											<div className="form-actions">
												{run.count > 0 && (
													<button
														type="button"
														className="button button-primary"
														onClick={() => void startRun(false)}
														disabled={busy}
													>
														Label {run.count} messages
													</button>
												)}
												<button type="button" className="button" onClick={() => setRun(null)} disabled={busy}>
													Cancel
												</button>
											</div>
										</div>
									)}
								</section>
							</>
						)}
						{error && (
							<p className="form-error" role="alert">
								{error}
							</p>
						)}
					</>
				)}
			</div>
			<div className="dialog-actions">
				<button type="button" className="button" onClick={onClose}>
					Done
				</button>
			</div>
		</Dialog>
	);
}
