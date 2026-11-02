// Bindings that `wrangler types` cannot see. Secrets are set with `wrangler secret put`, never in
// wrangler.jsonc.
interface Env {
	/** Turns on `POST /auth/setup` while it is set. Delete it after the first-run setup. */
	SETUP_TOKEN?: string;
}
