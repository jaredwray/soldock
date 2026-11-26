// Bindings that `wrangler types` cannot see. Secrets are set with `wrangler secret put`, never in
// wrangler.jsonc.
interface Env {
	/** Permits setup and a directory reset at 32 characters or more. Delete it after setup. */
	SETUP_TOKEN?: string;
	/**
	 * Deprecated. Admin › Chat keeps the Web Push key pair in the database. These secrets apply only until the
	 * first change there, which copies them. The pair is an uncompressed P-256 public key and a 32-byte
	 * private key, both in base64url.
	 */
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	/** Deprecated, as the key pair. A mailto or https contact address for the push service. */
	VAPID_SUBJECT?: string;
	/**
	 * The Cloudflare API token for Workers AI through AI Gateway, when an owner or an admin did not save one in
	 * Admin › AI. A token of the settings wins. It is never in an API answer or in a log.
	 */
	AI_GATEWAY_TOKEN?: string;
	/**
	 * Optional. The Worker encrypts the secrets that it stores and must read back, with a key from this value.
	 * Without it, the Worker stores them as plaintext. It must have 32 characters or more: a shorter value makes
	 * each write of a secret fail. A lost or changed value makes the sealed values unreadable. It is never in an
	 * API answer or in a log.
	 */
	ENCRYPTION_KEY?: string;
}
