// The first values of the approval page. The person can change each of them.

/** A name for a new agent from the name that the client gave itself, valid as a display name. */
export function agentNameFromClient(clientName: string): string {
	const name = clientName
		.replace(/[\p{Cc}"<>\\]/gu, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 100);
	return name || "Agent";
}

/** An address for a new agent on the first mail domain, from the client name. Empty without a domain. */
export function suggestedAddress(clientName: string, domains: readonly string[]): string {
	const domain = domains[0];
	if (!domain) return "";
	const local =
		clientName
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32)
			.replace(/-+$/, "") || "agent";
	return `${local}@${domain}`;
}
