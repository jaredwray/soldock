/** The source of one image: the version of the repository and the commit that the image holds. */
export interface ImageSource {
	/** The version in the root package.json, as MAJOR.MINOR.PATCH. */
	version: string;
	/** The full SHA of the commit. */
	commit: string;
	/** The committer date of the commit, in seconds since the Unix epoch. */
	committedAt: number;
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * The version tag of the development image of one commit, for example
 * `0.0.0-development.20261119231245.g61ff1b8c2d3e`.
 *
 * The tag is a semver prerelease and a valid Docker tag. The time is the committer date in UTC, as
 * YYYYMMDDHHMMSS, so the tag of a later commit has a higher precedence. The `g` makes the commit an
 * alphanumeric identifier: semver refuses a numeric identifier that starts with 0.
 */
export function developmentVersion({ version, commit, committedAt }: ImageSource): string {
	if (!VERSION.test(version)) throw new Error(`The version must be MAJOR.MINOR.PATCH, not "${version}".`);
	if (!COMMIT.test(commit)) throw new Error(`The commit must be a full SHA, not "${commit}".`);
	if (!Number.isSafeInteger(committedAt) || committedAt <= 0) {
		throw new Error(`The commit time must be a number of seconds, not "${committedAt}".`);
	}
	const time = new Date(committedAt * 1000).toISOString().replace(/\D/g, "").slice(0, 14);
	return `${version}-development.${time}.g${commit.slice(0, 12)}`;
}
