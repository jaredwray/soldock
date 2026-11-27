import { EmailAddress } from "@asterra/contracts";

/**
 * The domain that a list of the saved domains selects first. `address` is the address whose domain the list
 * prefers: the address of the admin in the New member form, and the primary address of the mailbox in the
 * Aliases form. If that domain is not saved, it is the first saved domain. With no saved domain, it is empty.
 */
export function defaultMailDomain(domains: readonly string[], address: string): string {
	const own = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
	return domains.includes(own) ? own : (domains[0] ?? "");
}

/**
 * The address that the New member form checks with `directory.check_address`, or null when there is nothing
 * to check: no mailbox name, no domain, or a mailbox name that cannot make a valid address. The form shows its
 * own message for a name that is not valid, so the server does not check it.
 */
export function addressToCheck(localPart: string, domain: string): string | null {
	const local = localPart.trim();
	if (!local || !domain || local.includes("@")) return null;
	const address = `${local}@${domain}`;
	return EmailAddress.safeParse(address).success ? address : null;
}
