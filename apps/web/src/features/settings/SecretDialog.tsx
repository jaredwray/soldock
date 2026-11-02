import type { CreatedApiKey } from "@soldock/contracts";
import { useId, useRef, useState } from "react";
import { Dialog } from "../../lib/Dialog.tsx";
import { Icon } from "../../lib/icons.tsx";

/** Shows the secret of a new API key. The server returns it once and never again. */
export function SecretDialog({
	apiKey,
	title,
	onClose,
}: {
	apiKey: CreatedApiKey;
	title?: string;
	onClose: () => void;
}) {
	const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();
	const warningId = useId();

	async function copy() {
		try {
			await navigator.clipboard.writeText(apiKey.secret);
			setCopied("yes");
		} catch {
			inputRef.current?.select();
			setCopied("failed");
		}
	}

	return (
		<Dialog title={title ?? "Copy the new API key"} onClose={onClose} className="dialog-small">
			<div className="dialog-body">
				<p id={warningId} className="warning-box">
					<Icon name="warning" size={18} />
					<span>
						This key is shown only once. Copy it now and keep it in a safe place. Anyone with the key can act as its
						owner.
					</span>
				</p>
				<label htmlFor={inputId} className="field-label">
					API key “{apiKey.label}”
				</label>
				<div className="secret-row">
					<input
						ref={inputRef}
						id={inputId}
						className="input input-mono"
						readOnly
						value={apiKey.secret}
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
					{copied === "failed" && "Copy did not work. The key is selected: press Ctrl+C or Cmd+C."}
				</p>
				<p className="field-hint">Scopes: {apiKey.scopes.join(", ")}</p>
			</div>
			<div className="dialog-actions">
				<button type="button" className="button" onClick={onClose}>
					Done
				</button>
			</div>
		</Dialog>
	);
}
