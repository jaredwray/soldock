import type { MeetConnectionTest, MeetSettings } from "@asterra/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
import { useToast } from "../../lib/toast.tsx";
import {
	changeOf,
	draftOf,
	type MeetDraft,
	type PairDraft,
	type PairNames,
	SFU_NAMES,
	statusText,
	TURN_NAMES,
} from "./meetSettingsModel.ts";

type Check = MeetConnectionTest["sfu"];

function checkText(name: string, check: Check): string {
	if (check.ok) return `${name}: Cloudflare answered in ${check.latency_ms} ms.`;
	switch (check.reason) {
		case "not_configured":
			return `${name}: not set up.`;
		case "timeout":
			return `${name}: Cloudflare did not answer.`;
		case "bad_response":
			return `${name}: Cloudflare gave an answer that Asterra cannot read.`;
		default:
			return check.status === 401 || check.status === 403
				? `${name}: Cloudflare refused the values (HTTP ${check.status}). Check the ID and the secret.`
				: `${name}: Cloudflare refused the request (HTTP ${check.status ?? "?"}).`;
	}
}

interface PairProps {
	legend: string;
	hint: string;
	names: PairNames;
	draft: PairDraft;
	/** The saved ID, or null. */
	savedId: string | null;
	/** True when the pair that applies now is saved here. */
	fromSettings: boolean;
	/** The Worker secrets of the pair, when they apply now. */
	secretNames: string | null;
	busy: boolean;
	onChange(patch: Partial<PairDraft>): void;
}

/** One pair of values: the ID, and the secret that the page never shows again. */
function PairFields({ legend, hint, names, draft, savedId, fromSettings, secretNames, busy, onChange }: PairProps) {
	const ids = { id: useId(), secret: useId(), hint: useId() };
	const [replacing, setReplacing] = useState(false);
	const idChanged = draft.id.trim().toLowerCase() !== (savedId ?? "");
	const showSaved = fromSettings && savedId !== null && !replacing && !idChanged;
	return (
		<fieldset className="meet-admin-pair" disabled={busy}>
			<legend className="panel-title">{legend}</legend>
			<p id={ids.hint} className="field-hint">
				{hint}
			</p>
			{secretNames && (
				<p className="field-hint">
					The Worker secrets {secretNames} are in use. Values that you save here replace them.
				</p>
			)}
			<div className="form-grid">
				<div className="field">
					<label htmlFor={ids.id} className="field-label">
						{names.idLabel}
					</label>
					<input
						id={ids.id}
						className="input input-mono"
						autoComplete="off"
						autoCapitalize="none"
						spellCheck={false}
						value={draft.id}
						onChange={(event) => onChange({ id: event.target.value, remove: false })}
						aria-describedby={ids.hint}
					/>
				</div>
				<div className="field">
					<label htmlFor={ids.secret} className="field-label">
						{names.secretLabel}
					</label>
					{showSaved ? (
						<div className="ai-token-saved">
							<span>
								{draft.remove ? "The pair goes when you save." : "A secret is saved. Asterra never shows it again."}
							</span>
							{draft.remove ? (
								<button type="button" className="button button-small" onClick={() => onChange({ remove: false })}>
									Keep it
								</button>
							) : (
								<>
									<button
										type="button"
										className="button button-small"
										aria-label={`Replace the ${names.secretLabel}`}
										onClick={() => setReplacing(true)}
									>
										Replace
									</button>
									<button
										type="button"
										className="button button-small"
										aria-label={`Remove the ${names.idLabel} and the ${names.secretLabel}`}
										onClick={() => onChange({ remove: true })}
									>
										Remove
									</button>
								</>
							)}
						</div>
					) : (
						<input
							id={ids.secret}
							className="input input-mono"
							type="password"
							autoComplete="new-password"
							autoCapitalize="none"
							spellCheck={false}
							placeholder={idChanged && draft.id.trim() !== "" ? "Required for the new ID" : "Paste the secret"}
							value={draft.secret}
							onChange={(event) => onChange({ secret: event.target.value })}
						/>
					)}
				</div>
			</div>
		</fieldset>
	);
}

/**
 * Admin › Meet: the Cloudflare Realtime values of Meet (`meet.update_settings`). The SFU app is required. The TURN key
 * is optional. A pair that is not saved here comes from the Worker secrets, when they are set.
 */
export function MeetAdminSection() {
	const toast = useToast();
	const [saved, setSaved] = useState<MeetSettings | null>(null);
	const [draft, setDraft] = useState<MeetDraft | null>(null);
	// A new key for the pairs after each save, so a pair closes its Replace input.
	const [version, setVersion] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [testing, setTesting] = useState(false);
	const [test, setTest] = useState<MeetConnectionTest | null>(null);
	const ids = { heading: useId() };

	const load = useCallback(async () => {
		setError(null);
		try {
			const settings = await api.call("meet.get_settings");
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
					<p className="panel-card panel-empty">Loading the Meet settings…</p>
				)}
			</section>
		);
	}

	const settings = saved;
	const current = draft;
	const { patch, problem } = changeOf(current, settings);
	const dirty = Object.keys(patch).length > 0 || problem !== null;

	async function save(event: FormEvent) {
		event.preventDefault();
		if (problem) {
			setError(problem);
			return;
		}
		if (Object.keys(patch).length === 0) return;
		setBusy(true);
		setError(null);
		try {
			const next = await api.call("meet.update_settings", patch);
			setSaved(next);
			setDraft(draftOf(next));
			setVersion((value) => value + 1);
			setTest(null);
			toast({ message: "The Meet settings are saved." });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function runTest() {
		setTesting(true);
		try {
			setTest(await api.call("meet.test_connection", {}));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setTesting(false);
		}
	}

	return (
		<section className="panel">
			<div className="panel-heading">
				<p className="panel-intro">
					Meet sends audio and video through Cloudflare Realtime in your Cloudflare account. Create an SFU app and a
					TURN key in Cloudflare › Realtime, then paste their values here.
				</p>
			</div>
			<form className="panel-card panel-form" onSubmit={save} noValidate aria-labelledby={ids.heading}>
				<h2 id={ids.heading} className="panel-title">
					Cloudflare Realtime
				</h2>
				<div className={settings.ready ? "notice notice-ok" : "notice notice-warning"} role="status">
					<Icon
						name={settings.ready ? "check" : "warning"}
						size={16}
						className={settings.ready ? "notice-icon notice-icon-ok" : "notice-icon"}
					/>
					<span>{statusText(settings)}</span>
				</div>
				<PairFields
					key={`sfu-${version}`}
					legend="Realtime SFU app"
					hint="Required. Cloudflare › Realtime › Serverless SFU: the App ID and the App Secret of the app."
					names={SFU_NAMES}
					draft={current.sfu}
					savedId={settings.app_id}
					fromSettings={settings.sfu_source === "settings"}
					secretNames={settings.sfu_source === "secret" ? "REALTIME_APP_ID and REALTIME_APP_SECRET" : null}
					busy={busy}
					onChange={(change) => setDraft({ ...current, sfu: { ...current.sfu, ...change } })}
				/>
				<PairFields
					key={`turn-${version}`}
					legend="TURN key (optional)"
					hint="Cloudflare › Realtime › TURN: the Key ID and the API token. Without it, a network that blocks UDP cannot carry the media."
					names={TURN_NAMES}
					draft={current.turn}
					savedId={settings.turn_key_id}
					fromSettings={settings.turn_source === "settings"}
					secretNames={settings.turn_source === "secret" ? "REALTIME_TURN_KEY_ID and REALTIME_TURN_KEY_TOKEN" : null}
					busy={busy}
					onChange={(change) => setDraft({ ...current, turn: { ...current.turn, ...change } })}
				/>
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				<div className="form-actions">
					<button type="submit" className="button button-primary" disabled={busy || !dirty}>
						{busy ? "Please wait…" : "Save Meet settings"}
					</button>
					{dirty && (
						<button
							type="button"
							className="button"
							onClick={() => {
								setDraft(draftOf(settings));
								setVersion((value) => value + 1);
								setError(null);
							}}
							disabled={busy}
						>
							Discard changes
						</button>
					)}
				</div>
				<div className="ai-test">
					<button type="button" className="button" onClick={() => void runTest()} disabled={testing || busy}>
						{testing ? "Testing…" : "Test connection"}
					</button>
					<p className="ai-test-result" aria-live="polite">
						{test &&
							(
								[
									["SFU app", test.sfu],
									["TURN key", test.turn],
								] as const
							).map(([name, check]) => (
								<span key={name} className="meet-admin-check">
									<Icon
										name={check.ok ? "check" : "warning"}
										size={16}
										className={check.ok ? "ai-test-icon ai-test-icon-ok" : "ai-test-icon ai-test-icon-failed"}
									/>{" "}
									{checkText(name, check)}
								</span>
							))}
					</p>
				</div>
				<p className="field-hint">The test uses the saved values. Save a change first.</p>
			</form>
		</section>
	);
}
