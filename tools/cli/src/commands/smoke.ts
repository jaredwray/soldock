// `asterra smoke <url>`, and the smoke check after a deploy.
import { type Context, say } from "../context.ts";
import { smokeCheck } from "../smoke.ts";

/** Runs the smoke check and shows each result. True when each check passed. */
export async function runSmoke(ctx: Context, origin: string): Promise<boolean> {
	say(ctx, `Smoke check of ${origin} (a new host can take some minutes to answer)`);
	const results = await smokeCheck(origin, { httpGet: ctx.httpGet, sleep: ctx.sleep, now: ctx.now });
	for (const result of results) {
		if (result.ok) {
			say(ctx, `  ok: ${result.name}`);
		} else {
			say(ctx, `  failed: ${result.name} (${result.detail})`);
			// GitHub Actions shows this line as an error of the step.
			if (ctx.env.GITHUB_ACTIONS === "true") ctx.io.err(`::error::smoke check: ${result.name} (${result.detail})\n`);
		}
	}
	return results.every((result) => result.ok);
}
