// The release notes before an upgrade. They are in GitHub Releases only.
import { type Context, say } from "./context.ts";
import { parseVersion } from "./wrangler.ts";

export const RELEASES_REPO = "jaredwray/soldock";

interface Release {
	tag_name: string;
	body?: string | null;
	draft?: boolean;
}

/** Negative when a < b, positive when a > b. */
export function compareVersions(a: string, b: string): number {
	const x = parseVersion(a) ?? [0, 0, 0];
	const y = parseVersion(b) ?? [0, 0, 0];
	return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

const TIMEOUT_MS = 10_000;

/**
 * Shows the notes of each release after `from` up to `to`. Without the notes, it shows the link. A run
 * without questions shows only the link: nobody reads the notes before the upgrade, so the run does not
 * call GitHub.
 */
export async function showReleaseNotes(ctx: Context, from: string | null, to: string): Promise<void> {
	const link = `https://github.com/${RELEASES_REPO}/releases/tag/v${to}`;
	if (!ctx.prompt.interactive) {
		say(ctx, `Release notes: ${link}`);
		return;
	}
	let releases: Release[] = [];
	try {
		const response = await ctx.fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=100`, {
			headers: { accept: "application/vnd.github+json", "user-agent": "asterra-cli" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const body: unknown = response.ok ? await response.json() : [];
		if (Array.isArray(body)) releases = body as Release[];
	} catch {
		// No answer from GitHub in 10 seconds, or no network. The link is enough.
	}
	const shown = releases
		.filter((release) => !release.draft && /^v?\d+\.\d+\.\d+$/.test(release.tag_name))
		.filter((release) => {
			const version = release.tag_name.replace(/^v/, "");
			return compareVersions(version, to) <= 0 && (from === null ? version === to : compareVersions(version, from) > 0);
		})
		.sort((a, b) => compareVersions(a.tag_name, b.tag_name));
	if (shown.length === 0) {
		say(ctx, `Release notes: ${link}`);
		return;
	}
	for (const release of shown) {
		say(ctx, `── ${release.tag_name} ──`);
		say(ctx, (release.body ?? "").trim() || "(no notes)");
		say(ctx);
	}
}
