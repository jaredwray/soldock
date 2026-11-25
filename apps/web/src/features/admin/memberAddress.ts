/**
 * The domain that the New member form selects first. It is the domain of the address of the admin, if
 * that domain is saved. If not, it is the first saved domain. With no saved domain, it is empty.
 */
export function defaultMailDomain(domains: readonly string[], ownAddress: string): string {
	const own = ownAddress.slice(ownAddress.lastIndexOf("@") + 1).toLowerCase();
	return domains.includes(own) ? own : (domains[0] ?? "");
}
