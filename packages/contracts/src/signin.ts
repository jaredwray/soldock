import { EmailAddress } from "./common.ts";
import { z } from "./zod.ts";

// Sign-in with a password and, when the person turned it on, a TOTP code (`/auth/session`). Sign-in
// creates a credential, so it is a ceremony and not an operation: it has no REST route in the registry
// and no MCP tool. The dock Worker and the web app share these schemas.

/** The shortest password that Asterra accepts. Length gives more strength than character rules. */
export const PASSWORD_MIN_LENGTH = 12;

/** The longest password that Asterra accepts. The limit keeps the hash work small. */
export const PASSWORD_MAX_LENGTH = 128;

/** A new password: at least 12 and at most 128 characters. Spaces are part of the password. */
export const Password = z
	.string()
	.min(PASSWORD_MIN_LENGTH, `must have at least ${PASSWORD_MIN_LENGTH} characters`)
	.max(PASSWORD_MAX_LENGTH, `must have at most ${PASSWORD_MAX_LENGTH} characters`);

/** The number of digits in a TOTP code (RFC 6238). Authenticator apps show 6 digits. */
export const TOTP_DIGITS = 6;

/** A TOTP code changes after this number of seconds. */
export const TOTP_PERIOD_SECONDS = 30;

/** The code from an authenticator app. Spaces and hyphens are ignored. */
export const TotpCode = z
	.string()
	.max(16)
	.transform((code) => code.replace(/[\s-]/g, ""))
	.pipe(z.string().regex(new RegExp(`^\\d{${TOTP_DIGITS}}$`), `must have ${TOTP_DIGITS} digits`));

/** Sign-in stops for 15 minutes after this number of failed attempts in a row. */
export const SIGN_IN_MAX_FAILURES = 10;

/** The number of minutes that sign-in stays locked after too many failures. */
export const SIGN_IN_LOCK_MINUTES = 15;

/**
 * The body of `POST /auth/session`. The address is an Asterra address of the person. A person with
 * two-step verification also sends `totp_code`. The password has no minimum length here, so a short
 * guess gets the same answer as each other wrong password.
 */
export const SignInInput = z.strictObject({
	address: EmailAddress,
	password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
	totp_code: TotpCode.optional(),
});
export type SignInInput = z.input<typeof SignInInput>;

/**
 * The `200` response of `POST /auth/session`.
 * - `signed_in`: the response sets the session cookie.
 * - `totp_required`: the password is correct, and the person has two-step verification. Send the same
 *   body again with `totp_code`. No session exists yet.
 */
export const SignInResult = z.object({ status: z.enum(["signed_in", "totp_required"]) });
export type SignInResult = z.infer<typeof SignInResult>;

// Invite links (`/auth/invite/*`). An owner or an admin makes a link for a person who has no password yet
// (`directory.create_principal` without a password, or `directory.create_invite`). The person opens the link,
// chooses a password, and the server signs the person in. The accept creates a credential, so it is a
// ceremony and not an operation.

/** The number of days that an invite link works. */
export const INVITE_DAYS = 7;

/** The secret of an invite link: `sdi_` and 43 base64url characters. The link carries it after the `#`. */
export const InviteToken = z.string().regex(/^sdi_[A-Za-z0-9_-]{43}$/, "must be the token of an invite link");

/** The body of `POST /auth/invite/check`. */
export const InviteCheckInput = z.strictObject({ token: InviteToken });
export type InviteCheckInput = z.input<typeof InviteCheckInput>;

/** The `200` response of `POST /auth/invite/check`: the person of a live invite. */
export const InviteCheckResult = z.object({
	display_name: z.string(),
	address: z.string(),
	/** When the link stops. */
	expires_at: z.string(),
});
export type InviteCheckResult = z.infer<typeof InviteCheckResult>;

/** The body of `POST /auth/invite/accept`: the token and the first password of the person. */
export const InviteAcceptInput = z.strictObject({ token: InviteToken, password: Password });
export type InviteAcceptInput = z.input<typeof InviteAcceptInput>;

/** The `200` response of `POST /auth/invite/accept`. The response sets the session cookie. */
export const InviteAcceptResult = z.object({ status: z.literal("signed_in") });
export type InviteAcceptResult = z.infer<typeof InviteAcceptResult>;
