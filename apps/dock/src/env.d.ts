// Bindings that `wrangler types` cannot see. Secrets are set with `wrangler secret put`, never in
// wrangler.jsonc.
interface Env {
	/** Permits setup and a directory reset at 32 characters or more. Delete it after setup. */
	SETUP_TOKEN?: string;
	/** Web Push uses an uncompressed P-256 public key and a 32-byte private key, both in base64url. */
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	/** A mailto or https contact address for the push service. */
	VAPID_SUBJECT?: string;
	/**
	 * The Cloudflare API token for Workers AI through AI Gateway (Workers AI and AI Gateway permissions). It is
	 * never in the directory, in an API answer or in a log. Without it, AI makes no calls.
	 */
	AI_GATEWAY_TOKEN?: string;
}
