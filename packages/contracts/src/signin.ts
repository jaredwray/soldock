import { EmailAddress } from "./common.ts";
import { z } from "./zod.ts";

// Sign-in with a one-time code (`/auth/code` and `/auth/session`). Sign-in creates a credential, so
// it is a ceremony and not an operation: it has no REST route in the registry and no MCP tool. The
// dock Worker and the web app share these schemas.

/** The number of digits in a sign-in code. */
export const SIGN_IN_CODE_LENGTH = 8;

/** A sign-in code stops working after this number of minutes. */
export const SIGN_IN_CODE_TTL_MINUTES = 10;

/** The number of guesses that one code allows. After that, the person asks for a new code. */
export const SIGN_IN_CODE_MAX_ATTEMPTS = 5;

/**
 * The body of `POST /auth/code`. The address is the Soldock address of a person or their sign-in
 * email. The code always goes to the sign-in email.
 */
export const SignInCodeRequest = z.strictObject({ email: EmailAddress });
export type SignInCodeRequest = z.infer<typeof SignInCodeRequest>;

/** The body of `POST /auth/session`. Spaces and hyphens in the code are ignored. */
export const SignInInput = z.strictObject({
	email: EmailAddress,
	code: z
		.string()
		.max(32)
		.transform((code) => code.replace(/[\s-]/g, ""))
		.pipe(z.string().regex(new RegExp(`^\\d{${SIGN_IN_CODE_LENGTH}}$`), `must have ${SIGN_IN_CODE_LENGTH} digits`)),
});
export type SignInInput = z.input<typeof SignInInput>;
