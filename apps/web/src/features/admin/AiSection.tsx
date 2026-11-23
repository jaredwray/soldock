import { AI_MODELS, type AiConnectionTest, type AiSettings } from "@asterra/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
import { Select } from "../../lib/Select.tsx";
import { useToast } from "../../lib/toast.tsx";
import { AiUsage } from "./AiUsage.tsx";
import { type AiDraft, draftOf, featureModel, notReadyText, settingsPatch } from "./aiModel.ts";

/** A switch: a button with role="switch", and a label and a hint next to it. */
function Switch(props: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: string;
	hint?: string | null;
	disabled?: boolean;
}) {
	const labelId = useId();
	const hintId = useId();
	return (
		<div className="switch-row">
			<button
				type="button"
				role="switch"
				className="switch"
				aria-checked={props.checked}
				aria-labelledby={labelId}
				aria-describedby={props.hint ? hintId : undefined}
				onClick={() => props.onChange(!props.checked)}
				disabled={props.disabled}
			/>
			<span className="switch-text">
				<span id={labelId} className="switch-label">
					{props.label}
				</span>
				{props.hint && (
					<span id={hintId} className="check-hint">
						{props.hint}
					</span>
				)}
			</span>
		</div>
	);
}

function testResultText(result: AiConnectionTest): string {
	if (result.ok) return `The gateway answered in ${result.latency_ms} ms with ${result.model}.`;
	switch (result.reason) {
		case "no_gateway":
			return "Enter and save the account ID and the gateway ID first.";
		case "no_token":
			return "The Worker secret AI_GATEWAY_TOKEN is not set. Set it with wrangler secret put AI_GATEWAY_TOKEN.";
		case "timeout":
			return "The gateway did not answer in 20 seconds.";
		case "http":
			return `The gateway refused the request (HTTP ${result.status}).${result.detail ? ` ${result.detail}` : ""}`;
		default:
			return "The answer of the gateway was not valid.";
	}
}

/**
 * Admin › AI. An owner or an admin connects the AI Gateway of the Cloudflare account, turns on AI,
 * chooses the Workers AI models and the model of each feature, and sets the monthly budget. The usage
 * of the month shows below the settings.
 */
export function AiSection() {
	const [saved, setSaved] = useState<AiSettings | null>(null);
	const [draft, setDraft] = useState<AiDraft | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [testing, setTesting] = useState(false);
	const [test, setTest] = useState<AiConnectionTest | null>(null);
	const [usageVersion, setUsageVersion] = useState(0);
	const toast = useToast();
	const ids = {
		connection: useId(),
		account: useId(),
		gateway: useId(),
		models: useId(),
		features: useId(),
		featureModel: useId(),
		budget: useId(),
		budgetHint: useId(),
	};

	const load = useCallback(async () => {
		setLoadError(null);
		try {
			const settings = await api.call("ai.get_settings");
			setSaved(settings);
			setDraft(draftOf(settings));
		} catch (caught) {
			setLoadError(errorMessage(caught));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	if (loadError && !saved) {
		return (
			<section className="panel">
				<div className="panel-card panel-form" role="alert">
					<p>The AI settings did not load. {loadError}</p>
					<button type="button" className="button" onClick={() => void load()}>
						Try again
					</button>
				</div>
			</section>
		);
	}
	if (!saved || !draft) return <p className="panel-card panel-empty">Loading the AI settings…</p>;

	const change = (patch: Partial<AiDraft>) => setDraft({ ...draft, ...patch });
	const checked = settingsPatch(saved, draft);
	const dirty = !checked.ok || Object.keys(checked.patch).length > 0;
	const allowed = AI_MODELS.filter((model) => draft.allowedModels.includes(model.id));
	const autoModel = featureModel(draft);

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!saved || !draft) return;
		const result = settingsPatch(saved, draft);
		if (!result.ok) return setError(result.error);
		if (Object.keys(result.patch).length === 0) return;
		setBusy(true);
		setError(null);
		try {
			const next = await api.call("ai.update_settings", result.patch);
			setSaved(next);
			setDraft(draftOf(next));
			setUsageVersion((value) => value + 1);
			toast({ message: "AI settings saved." });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function runTest() {
		setTesting(true);
		setTest(null);
		try {
			setTest(await api.call("ai.test_connection", {}));
			setUsageVersion((value) => value + 1);
		} catch (caught) {
			setTest({
				ok: false,
				status: null,
				latency_ms: 0,
				model: null,
				reason: "bad_response",
				detail: errorMessage(caught),
			});
		} finally {
			setTesting(false);
		}
	}

	const notReady = notReadyText(saved.not_ready_reason);

	return (
		<>
			<section className="panel">
				<div className="panel-heading">
					<p className="panel-intro">
						Use AI from Workers AI through the Cloudflare AI Gateway of your account. The AI stays in your Cloudflare
						account, and the budget stops it each month.
					</p>
					<p className="panel-note">
						Create an AI Gateway in the Cloudflare dashboard, and set its API token as the Worker secret
						AI_GATEWAY_TOKEN. The self-hosting guide has the steps.
					</p>
				</div>
				<div className={saved.ready ? "notice notice-ok" : "notice notice-warning"} role="status">
					<Icon
						name={saved.ready ? "check" : "warning"}
						size={16}
						className={saved.ready ? "notice-icon notice-icon-ok" : "notice-icon"}
					/>
					<span>{saved.ready ? "AI is ready. Features that are on can use it." : notReady}</span>
				</div>
				<form className="panel-card panel-form" onSubmit={save} noValidate>
					<fieldset className="ai-fieldset" aria-labelledby={ids.connection}>
						<h2 id={ids.connection} className="panel-title">
							Connection
						</h2>
						<div className="field">
							<label htmlFor={ids.account} className="field-label">
								Cloudflare account ID
							</label>
							<input
								id={ids.account}
								className="input input-mono"
								type="text"
								autoComplete="off"
								autoCapitalize="none"
								spellCheck={false}
								placeholder="0123456789abcdef0123456789abcdef"
								value={draft.accountId}
								onChange={(event) => change({ accountId: event.target.value })}
								disabled={busy}
							/>
						</div>
						<div className="field">
							<label htmlFor={ids.gateway} className="field-label">
								AI Gateway ID
							</label>
							<input
								id={ids.gateway}
								className="input input-mono"
								type="text"
								autoComplete="off"
								autoCapitalize="none"
								spellCheck={false}
								placeholder="asterra"
								value={draft.gatewayId}
								onChange={(event) => change({ gatewayId: event.target.value })}
								disabled={busy}
							/>
						</div>
						<p className="field-hint">
							API token:{" "}
							{saved.token_configured ? (
								<strong>the Worker secret AI_GATEWAY_TOKEN is set.</strong>
							) : (
								<strong>
									the Worker secret AI_GATEWAY_TOKEN is not set. Run <code>wrangler secret put AI_GATEWAY_TOKEN</code>.
								</strong>
							)}
						</p>
						<div className="ai-test">
							<button type="button" className="button" onClick={() => void runTest()} disabled={testing || busy}>
								{testing ? "Testing…" : "Test connection"}
							</button>
							<p className="ai-test-result" aria-live="polite">
								{test && (
									<span>
										<Icon
											name={test.ok ? "check" : "warning"}
											size={14}
											className={test.ok ? "ai-test-icon ai-test-icon-ok" : "ai-test-icon ai-test-icon-failed"}
										/>{" "}
										{testResultText(test)}
									</span>
								)}
							</p>
						</div>
					</fieldset>

					<Switch
						checked={draft.enabled}
						onChange={(enabled) => change({ enabled })}
						label="Use AI in this organization"
						hint="When AI is off, no feature calls the gateway."
						disabled={busy}
					/>

					<fieldset className="ai-fieldset">
						<legend id={ids.models} className="panel-title">
							Allowed models
						</legend>
						<p className="field-hint">
							Workers AI models only. Prices are for 1 million tokens, from Cloudflare in {saved.price_date}.
						</p>
						<div className="scope-list">
							{AI_MODELS.map((model) => {
								const on = draft.allowedModels.includes(model.id);
								return (
									<label key={model.id} className="check-row">
										<input
											type="checkbox"
											className="checkbox"
											checked={on}
											onChange={() =>
												change({
													allowedModels: on
														? draft.allowedModels.filter((id) => id !== model.id)
														: [...draft.allowedModels, model.id],
												})
											}
											disabled={busy}
										/>
										<span>
											{model.name}
											{model.recommended && <span className="chip chip-small ai-chip">Recommended</span>}
											<span className="check-hint">
												${model.input} in · ${model.output} out
											</span>
										</span>
									</label>
								);
							})}
						</div>
					</fieldset>

					<fieldset className="ai-fieldset" aria-labelledby={ids.features}>
						<h2 id={ids.features} className="panel-title">
							Features
						</h2>
						<Switch
							checked={draft.autoLabelEnabled}
							onChange={(autoLabelEnabled) => change({ autoLabelEnabled })}
							label="Inbox auto labels"
							hint="Each person turns on auto labels for their mailbox in Mail. Rules from the headers apply first, so most bulk mail costs nothing."
							disabled={busy}
						/>
						<div className="field">
							<label htmlFor={ids.featureModel} className="field-label">
								Model for inbox auto labels
							</label>
							<Select
								id={ids.featureModel}
								value={autoModel ?? ""}
								placeholder="Allow a model first"
								options={allowed.map((model) => ({ value: model.id, label: model.name }))}
								onChange={(value) => change({ autoLabelModel: value })}
								disabled={busy || allowed.length === 0}
							/>
						</div>
					</fieldset>

					<div className="field">
						<label htmlFor={ids.budget} className="field-label">
							Monthly budget (USD)
						</label>
						<input
							id={ids.budget}
							className="input"
							type="number"
							inputMode="decimal"
							min="0.01"
							step="0.01"
							value={draft.budget}
							onChange={(event) => change({ budget: event.target.value })}
							aria-describedby={ids.budgetHint}
							disabled={busy}
						/>
						<p id={ids.budgetHint} className="field-hint">
							AI stops when the estimate for the month reaches the budget. Labels from rules continue.
						</p>
					</div>

					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
					<div className="form-actions">
						<button type="submit" className="button button-primary" disabled={busy || !dirty}>
							{busy ? "Please wait…" : "Save AI settings"}
						</button>
						{dirty && (
							<button
								type="button"
								className="button"
								onClick={() => {
									setDraft(draftOf(saved));
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
			<AiUsage refresh={usageVersion} />
		</>
	);
}
