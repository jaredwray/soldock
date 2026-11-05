import { z } from "zod";
import { EmailAddress } from "./common.ts";
import { CreatedApiKey, DisplayName, Principal } from "./directory.ts";
import { MailDomain } from "./domains.ts";

// First-run setup (`/auth/setup`). Setup creates a credential, so it is a ceremony and not an
// operation: it has no REST route in the registry and no MCP tool. The dock Worker and the web app
// share these schemas.

/** The shortest `SETUP_TOKEN` secret that turns setup on. A shorter secret keeps setup off. */
export const SETUP_TOKEN_MIN_LENGTH = 32;

/**
 * `GET /auth/setup`. A valid token permits setup or a fresh start without a directory query.
 * Otherwise, setup is available only when the directory is empty.
 */
export const SetupStatus = z.discriminatedUnion("setup_needed", [
	z.object({
		setup_needed: z.literal(true),
		/** `missing`: no `SETUP_TOKEN` secret. `too_short`: shorter than `SETUP_TOKEN_MIN_LENGTH`. */
		setup_token: z.enum(["missing", "too_short", "ready"]),
		start_fresh_available: z.boolean().optional(),
	}),
	z.object({ setup_needed: z.literal(false) }),
]);
export type SetupStatus = z.infer<typeof SetupStatus>;

/**
 * The body of `POST /auth/setup`. The setup token goes in the `Authorization` header. The sign-in
 * email is an address outside the mail domains: the owner gets sign-in codes there.
 */
export const SetupInput = z.strictObject({
	mail_domain: MailDomain,
	display_name: DisplayName,
	address: EmailAddress,
	sign_in_email: EmailAddress,
	/** Explicit consent to delete the directory before the new owner is created. */
	start_fresh: z.literal("DELETE DIRECTORY").optional(),
});
export type SetupInput = z.infer<typeof SetupInput>;

/** The `201` response of `POST /auth/setup`: the owner and the owner's first API key, shown once. */
export const SetupResult = z.object({
	principal: Principal,
	api_key: CreatedApiKey,
});
export type SetupResult = z.infer<typeof SetupResult>;
