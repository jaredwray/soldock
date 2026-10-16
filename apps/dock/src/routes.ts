/**
 * Path prefixes the Worker owns (architecture §3). Every other path belongs to the SPA.
 *
 * `wrangler.jsonc` lists the same prefixes in `assets.run_worker_first`, as `<prefix>*`, because
 * browser navigations otherwise go straight to static assets. ``test/config.test.ts` keeps the two in sync.
 */
export const WORKER_PREFIXES = [
	"/api/",
	"/mcp",
	"/oauth/",
	"/.well-known/",
	"/auth/",
	"/ws/",
	"/blob/",
	"/dl/",
	"/hooks/",
] as const;

/** True when the Worker answers this path itself, so it must never fall back to the SPA. */
export function isWorkerPath(pathname: string): boolean {
	return WORKER_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
