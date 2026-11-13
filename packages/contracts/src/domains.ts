import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

/** A DNS domain without a scheme, path, wildcard, or mailbox name. */
export const MailDomain = z
	.string()
	.trim()
	.toLowerCase()
	.max(253)
	.regex(
		/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
		"Enter a domain such as example.com.",
	);

const output = z.object({ mail_domains: z.array(z.string()) });

export const domainOperations = {
	"directory.list_mail_domains": defineOperation({
		name: "directory.list_mail_domains",
		summary: "List the mail domains in admin settings",
		description:
			"Owners and admins can read the saved mail domains. DNS and Cloudflare email configuration remain separate.",
		http: { method: "GET", path: "/api/v1/directory/mail-domains" },
		scopes: ["directory.read"],
		callers: ["human"],
		annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
		input: z.strictObject({}),
		output,
		errors: [],
	}),
	"directory.add_mail_domain": defineOperation({
		name: "directory.add_mail_domain",
		summary: "Add a mail domain to admin settings",
		description: "Owners and admins only. Configure DNS and Cloudflare email separately.",
		http: { method: "POST", path: "/api/v1/directory/mail-domains" },
		scopes: ["directory.write"],
		callers: ["human"],
		annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
		input: z.strictObject({ domain: MailDomain }),
		output,
		errors: ["conflict"],
	}),
	"directory.remove_mail_domain": defineOperation({
		name: "directory.remove_mail_domain",
		summary: "Remove an unused mail domain from admin settings",
		description:
			"Owners and admins only. A domain with a mailbox address cannot be removed. Cloudflare and DNS records stay in place.",
		http: { method: "DELETE", path: "/api/v1/directory/mail-domains/{domain}" },
		scopes: ["directory.write"],
		callers: ["human"],
		annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
		input: z.strictObject({ domain: MailDomain }),
		output,
		errors: ["conflict"],
	}),
} as const;
