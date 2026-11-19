import { useId, useRef, useState } from "react";
import { Icon } from "../../lib/icons.tsx";

/** The full URL of the MCP endpoint of this deployment. An MCP client needs only this URL. */
export function mcpEndpointUrl(origin: string = window.location.origin): string {
	return `${origin}/mcp`;
}

/**
 * The full URL of the MCP endpoint, with a copy button. An agent connects with OAuth: its MCP client
 * opens a page of Asterra, and a person approves it there and gives it an address and scopes.
 */
export function McpEndpointBanner() {
	const url = mcpEndpointUrl();
	const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
	const inputRef = useRef<HTMLInputElement>(null);
	const titleId = useId();
	const inputId = useId();
	const hintId = useId();

	async function copy() {
		try {
			await navigator.clipboard.writeText(url);
			setCopied("yes");
		} catch {
			inputRef.current?.select();
			setCopied("failed");
		}
	}

	return (
		<section className="panel-card mcp-banner" aria-labelledby={titleId}>
			<div>
				<label id={titleId} htmlFor={inputId} className="mcp-banner-title">
					MCP endpoint
				</label>
				<p id={hintId} className="panel-note">
					Add this URL to the MCP client of the agent. The client opens Asterra in a browser. Approve it there, and give
					the agent its address and its access. Clients without OAuth can use an API key instead.
				</p>
			</div>
			<div className="mcp-banner-row">
				<div className="link-field">
					<Icon name="link" size={18} />
					<input
						ref={inputRef}
						id={inputId}
						className="link-field-input"
						readOnly
						value={url}
						aria-describedby={hintId}
						onFocus={(event) => event.currentTarget.select()}
					/>
				</div>
				<button type="button" className="button button-primary" onClick={() => void copy()}>
					<Icon name="copy" size={16} />
					Copy
				</button>
			</div>
			<p className="field-hint" aria-live="polite">
				{copied === "yes" && "Copied to the clipboard."}
				{copied === "failed" && "Copy did not work. The URL is selected: press Ctrl+C or Cmd+C."}
			</p>
		</section>
	);
}
