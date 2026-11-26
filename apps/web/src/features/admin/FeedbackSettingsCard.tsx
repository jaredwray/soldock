import type { FeedbackSettings, InputOf } from "@asterra/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
import { useToast } from "../../lib/toast.tsx";
import { FEEDBACK_CHANGED_EVENT } from "../feedback/useFeedbackStatus.ts";

interface Draft {
	enabled: boolean;
	owner: string;
	name: string;
	token: string;
	removeToken: boolean;
}

function draftOf(settings: FeedbackSettings): Draft {
	return {
		enabled: settings.enabled,
		owner: settings.repo_owner,
		name: settings.repo_name,
		token: "",
		removeToken: false,
	};
}

/**
 * Admin › General: feedback (`feedback.update_settings`). When it is on and a GitHub token is saved, the rail shows
 * a Feedback button, and each report becomes a public issue in the repository. It is off by default.
 */
export function FeedbackSettingsCard() {
	const toast = useToast();
	const [saved, setSaved] = useState<FeedbackSettings | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [replacingToken, setReplacingToken] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { owner: useId(), name: useId(), token: useId(), tokenHint: useId(), heading: useId() };

	const load = useCallback(async () => {
		setError(null);
		try {
			const settings = await api.call("feedback.get_settings");
			setSaved(settings);
			setDraft(draftOf(settings));
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	if (saved === null || draft === null) {
		return (
			<section className="panel">
				{error ? (
					<div role="alert">
						<p className="form-error">{error}</p>
						<button type="button" className="button" onClick={() => void load()}>
							Try again
						</button>
					</div>
				) : (
					<p className="panel-card panel-empty">Loading the general settings…</p>
				)}
			</section>
		);
	}

	const current = draft;
	const settings = saved;
	const change: InputOf<"feedback.update_settings"> = {};
	if (current.enabled !== settings.enabled) change.enabled = current.enabled;
	if (current.owner.trim() !== settings.repo_owner) change.repo_owner = current.owner.trim();
	if (current.name.trim() !== settings.repo_name) change.repo_name = current.name.trim();
	if (current.removeToken) change.github_token = null;
	else if (current.token.trim() !== "") change.github_token = current.token.trim();
	const dirty = Object.keys(change).length > 0;

	function edit(patch: Partial<Draft>) {
		setDraft({ ...current, ...patch });
	}

	async function save(event: FormEvent) {
		event.preventDefault();
		if (!dirty) return;
		setBusy(true);
		setError(null);
		try {
			const next = await api.call("feedback.update_settings", change);
			setSaved(next);
			setDraft(draftOf(next));
			setReplacingToken(false);
			window.dispatchEvent(new Event(FEEDBACK_CHANGED_EVENT));
			toast({ message: "The feedback settings are saved." });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	const notReady =
		settings.not_ready_reason === "off"
			? "Feedback is off. People see no Feedback button."
			: "Save a GitHub token. Until then, people see no Feedback button.";

	return (
		<section className="panel">
			<div className="panel-heading">
				<p className="panel-intro">The general settings of your organization.</p>
			</div>
			<form className="panel-card panel-form" onSubmit={save} noValidate aria-labelledby={ids.heading}>
				<h2 id={ids.heading} className="panel-title">
					Feedback
				</h2>
				<div className={settings.ready ? "notice notice-ok" : "notice notice-warning"} role="status">
					<Icon
						name={settings.ready ? "check" : "warning"}
						size={16}
						className={settings.ready ? "notice-icon notice-icon-ok" : "notice-icon"}
					/>
					<span>
						{settings.ready
							? `People can send feedback. Each report becomes a public issue in ${settings.repo_owner}/${settings.repo_name}.`
							: notReady}
					</span>
				</div>
				<label className="check-row">
					<input
						type="checkbox"
						className="checkbox"
						checked={current.enabled}
						onChange={() => edit({ enabled: !current.enabled })}
						disabled={busy}
					/>
					<span>
						Let people send feedback
						<span className="check-hint">
							The rail shows a Feedback button. A person reports a bug or sends an idea, with screenshots or a screen
							recording if they want. Each report becomes a public GitHub issue that each person on the internet can
							read. The issue names the host of this instance and the role of the person. The person chooses to show
							their name and their address. Agents cannot send feedback.
						</span>
					</span>
				</label>
				<div className="form-grid">
					<div className="field">
						<label htmlFor={ids.owner} className="field-label">
							Repository owner
						</label>
						<input
							id={ids.owner}
							className="input input-mono"
							autoComplete="off"
							autoCapitalize="none"
							spellCheck={false}
							value={current.owner}
							onChange={(event) => edit({ owner: event.target.value })}
							disabled={busy}
						/>
					</div>
					<div className="field">
						<label htmlFor={ids.name} className="field-label">
							Repository name
						</label>
						<input
							id={ids.name}
							className="input input-mono"
							autoComplete="off"
							autoCapitalize="none"
							spellCheck={false}
							value={current.name}
							onChange={(event) => edit({ name: event.target.value })}
							disabled={busy}
						/>
					</div>
				</div>
				<div className="field">
					<label htmlFor={ids.token} className="field-label">
						GitHub token
					</label>
					{settings.token_configured && !replacingToken ? (
						<div className="ai-token-saved">
							<span>
								{current.removeToken
									? "The token goes when you save."
									: "A token is saved. Asterra never shows it again."}
							</span>
							{current.removeToken ? (
								<button
									type="button"
									className="button button-small"
									onClick={() => edit({ removeToken: false })}
									disabled={busy}
								>
									Keep the token
								</button>
							) : (
								<>
									<button
										type="button"
										className="button button-small"
										aria-label="Replace the GitHub token"
										onClick={() => setReplacingToken(true)}
										disabled={busy}
									>
										Replace
									</button>
									<button
										type="button"
										className="button button-small"
										aria-label="Remove the GitHub token"
										onClick={() => edit({ removeToken: true })}
										disabled={busy}
									>
										Remove
									</button>
								</>
							)}
						</div>
					) : (
						<input
							id={ids.token}
							className="input input-mono"
							type="password"
							autoComplete="new-password"
							autoCapitalize="none"
							spellCheck={false}
							placeholder={settings.token_configured ? "Paste the new token" : "Paste the token"}
							value={current.token}
							onChange={(event) => edit({ token: event.target.value })}
							aria-describedby={ids.tokenHint}
							disabled={busy}
						/>
					)}
					<p id={ids.tokenHint} className="field-hint">
						A token that can create issues in the repository. The self-hosting guide tells which token to make.
					</p>
				</div>
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				<div className="form-actions">
					<button type="submit" className="button button-primary" disabled={busy || !dirty}>
						{busy ? "Please wait…" : "Save feedback settings"}
					</button>
					{dirty && (
						<button
							type="button"
							className="button"
							onClick={() => {
								setDraft(draftOf(settings));
								setReplacingToken(false);
								setError(null);
							}}
							disabled={busy}
						>
							Discard changes
						</button>
					)}
				</div>
			</form>
		</section>
	);
}
