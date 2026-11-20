import type { CreatedApiKey, CreatedWebhookEndpoint } from "@asterra/contracts";
import { type ReactNode, useId, useRef, useState } from "react";
import { Dialog } from "../../lib/Dialog.tsx";
import { Icon } from "../../lib/icons.tsx";
import { limitSummary } from "./keyLimits.ts";

/** Shows the secret of a new API key. The server returns it once and never again. */
export function SecretDialog({
	apiKey,
	title,
	onClose,
	children,
}: {
	apiKey: CreatedApiKey;
	title?: string;
	onClose: () => void;
	/** More text under the key, for example what to do next. */
	children?: ReactNode;
}) {
	return (
		<OneTimeSecretDialog
			title={title ?? "Copy the new API key"}
			label={`API key “${apiKey.label}”`}
			secret={apiKey.secret}
			warning="This key is shown only once. Copy it now and keep it in a safe place. Anyone with the key can act as its owner."
			onClose={onClose}
		>
			<p className="field-hint">Scopes: {apiKey.scopes.join(", ")}</p>
			{apiKey.limits &&
				limitSummary(apiKey.limits).map((line) => (
					<p key={line.product} className="field-hint">
						Limit for {line.product}: {line.text}
					</p>
				))}
			{children}
		</OneTimeSecretDialog>
	);
}

/** Shows the signing secret of a new webhook. The server returns it once and never again. */
export function WebhookSecretDialog({
	endpoint,
	problem,
	onClose,
}: {
	endpoint: CreatedWebhookEndpoint;
	/** A problem with the events of the new webhook. It shows here, because this dialog covers the page. */
	problem?: string | null;
	onClose: () => void;
}) {
	return (
		<OneTimeSecretDialog
			title="Copy the signing secret"
			label={`Signing secret of “${endpoint.label}”`}
			secret={endpoint.secret}
			warning="This secret is shown only once. Copy it now and give it to the receiver of the webhook, which uses it to verify each POST (Standard Webhooks)."
			onClose={onClose}
		>
			<p className="field-hint">URL: {endpoint.url}</p>
			{problem && (
				<p className="form-error" role="alert">
					{problem}
				</p>
			)}
		</OneTimeSecretDialog>
	);
}

/** A secret that the server returns once, with a copy button. */
function OneTimeSecretDialog({
	title,
	label,
	secret,
	warning,
	onClose,
	children,
}: {
	title: string;
	label: string;
	secret: string;
	warning: string;
	onClose: () => void;
	children?: ReactNode;
}) {
	const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();
	const warningId = useId();

	async function copy() {
		try {
			await navigator.clipboard.writeText(secret);
			setCopied("yes");
		} catch {
			inputRef.current?.select();
			setCopied("failed");
		}
	}

	return (
		<Dialog title={title} onClose={onClose} className="dialog-small">
			<div className="dialog-body">
				<p id={warningId} className="warning-box">
					<Icon name="warning" size={18} />
					<span>{warning}</span>
				</p>
				<label htmlFor={inputId} className="field-label">
					{label}
				</label>
				<div className="secret-row">
					<input
						ref={inputRef}
						id={inputId}
						className="input input-mono"
						readOnly
						value={secret}
						aria-describedby={warningId}
						onFocus={(event) => event.currentTarget.select()}
					/>
					<button type="button" className="button button-primary" onClick={() => void copy()} data-autofocus>
						<Icon name="copy" size={16} />
						Copy
					</button>
				</div>
				<p className="field-hint" aria-live="polite">
					{copied === "yes" && "Copied to the clipboard."}
					{copied === "failed" && "Copy did not work. The secret is selected: press Ctrl+C or Cmd+C."}
				</p>
				{children}
			</div>
			<div className="dialog-actions">
				<button type="button" className="button" onClick={onClose}>
					Done
				</button>
			</div>
		</Dialog>
	);
}
