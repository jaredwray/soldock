// Bindings that `wrangler types` cannot see. Secrets are set with `wrangler secret put`, never in
// wrangler.jsonc.
interface Env {
	/** Permits setup and a directory reset at 32 characters or more. Delete it after setup. */
	SETUP_TOKEN?: string;
}
