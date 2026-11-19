import { WEBHOOK_LIMITS } from "@asterra/contracts";
import type { PrincipalRecord } from "../identity/index.ts";

/** Host names that never reach a public server. A webhook cannot use them. */
const PRIVATE_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".invalid"];

/**
 * The problem with a webhook URL, or null when the URL is valid. A webhook URL has at most
 * `WEBHOOK_LIMITS.urlChars` characters, and it follows the rules of `publicUrlProblem`.
 */
export function webhookUrlProblem(value: string, dockOrigin: string): string | null {
	if (value.length > WEBHOOK_LIMITS.urlChars) return `The URL must have at most ${WEBHOOK_LIMITS.urlChars} characters.`;
	return publicUrlProblem(value, dockOrigin);
}

/**
 * The problem with a URL that the Worker sends a request to, or null when the URL is valid. Such a URL
 * is an absolute https URL on the default port, with a public host name: no IP address, no user name,
 * no fragment, and not the host of the deployment (`dockOrigin`). A Worker cannot reach a private
 * network, and these rules also keep the request off the deployment itself.
 */
export function publicUrlProblem(value: string, dockOrigin: string): string | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "The URL must be an absolute URL, such as https://hooks.example.com/asterra.";
	}
	if (url.protocol !== "https:") return "The URL must use https.";
	if (url.username || url.password) return "The URL must not contain a user name or a password.";
	if (url.port) return "The URL must use the default https port.";
	if (url.hash) return "The URL must not contain a fragment (#).";
	const host = url.hostname;
	// The URL parser turns each IPv4 form, such as 0x7f.1, into dotted decimal, and keeps IPv6 in brackets.
	if (host.startsWith("[") || /^[0-9.]+$/.test(host)) return "The URL must use a host name, not an IP address.";
	if (!host.includes(".") || host.endsWith(".")) {
		return "The URL must use a full host name, such as hooks.example.com.";
	}
	if (host === "localhost" || PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
		return "The URL must use a public host name.";
	}
	if (host === new URL(dockOrigin).hostname) return "The URL must not use the host of this deployment.";
	return null;
}

/**
 * True when the outbound policy of an agent allows a request to this host: mode `any`, or mode
 * `allowlist` with the host as a domain entry. An address entry never matches a host. A person has no
 * outbound policy, so each host is allowed.
 */
export function outboundHostAllowed(principal: PrincipalRecord, url: string): boolean {
	if (principal.kind !== "agent") return true;
	const mode = principal.outbound_mode ?? "internal-only";
	if (mode === "any") return true;
	if (mode !== "allowlist") return false;
	const host = new URL(url).hostname;
	return principal.outbound_allowlist.includes(host);
}
