import { useId, useRef, useState } from "react";
import { Icon } from "../../lib/icons.tsx";

/** The full URL of the MCP endpoint of this deployment. An MCP client needs only this URL. */
export function mcpEndpointUrl(origin: string = window.location.origin): string {
	return `${origin}/mcp`;
}

/**
 * The full URL of the MCP endpoint, with a copy button. An agent connects with OAuth: its MCP client
 * opens a page of Soldock, and a person approves it there and gives it an address and scopes.
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
		<section className="mcp-banner" aria-labelledby={titleId}>
			<label id={titleId} htmlFor={inputId} className="mcp-banner-title">
				<Icon name="link" size={18} />
				MCP endpoint
			</label>
			<div className="secret-row">
				<input
					ref={inputRef}
					id={inputId}
					className="input input-mono mcp-banner-url"
					readOnly
					value={url}
					aria-describedby={hintId}
					onFocus={(event) => event.currentTarget.select()}
				/>
				<button type="button" className="button button-primary" onClick={() => void copy()}>
					<Icon name="copy" size={16} />
					Copy
				</button>
			</div>
			<p id={hintId} className="field-hint">
				Add this URL to the MCP client of the agent. The client opens Soldock in a browser. Approve it there, and give
				the agent its address and its access. Clients without OAuth can use an API key instead.
			</p>
			<p className="field-hint" aria-live="polite">
				{copied === "yes" && "Copied to the clipboard."}
				{copied === "failed" && "Copy did not work. The URL is selected: press Ctrl+C or Cmd+C."}
			</p>
		</section>
	);
}
