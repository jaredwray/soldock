// The URL rules of OAuth: which redirect URIs a client can register, and how a redirect carries its values.

/** The longest redirect URI that a client can register. */
export const REDIRECT_URI_MAX_LENGTH = 2000;

/**
 * Schemes that a redirect URI can never use. The web app sends the browser to the redirect URI, so a
 * `javascript:` or `data:` URI would run code on this origin. The others open a file, a call or a
 * system handler instead of an app. `http:` is allowed only for a loopback address (RFC 8252).
 */
const REFUSED_SCHEMES = new Set([
	"about:",
	"blob:",
	"callto:",
	"chrome:",
	"data:",
	"facetime:",
	"facetime-audio:",
	"file:",
	"filesystem:",
	"ftp:",
	"intent:",
	"jar:",
	"javascript:",
	"mailto:",
	"sms:",
	"tel:",
	"vbscript:",
	"view-source:",
	"ws:",
	"wss:",
]);

/** Windows system handlers, such as `ms-msdt:` and `search-ms:`, which open tools of the system. */
const REFUSED_SCHEME_PATTERN = /^(?:ms-[a-z0-9.+-]*|search-ms|shell|res):$/;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Null when a client can register this redirect URI, or the reason why it cannot. A URI can use
 * `https:`, `http:` with a loopback host for an app on the computer of the person, or the scheme of a
 * native app, such as `cursor://`. It cannot hold a fragment or a user name.
 */
export function redirectUriProblem(value: string): string | null {
	if (value.length > REDIRECT_URI_MAX_LENGTH) return `is longer than ${REDIRECT_URI_MAX_LENGTH} characters`;
	if (/[\s\p{Cc}]/u.test(value)) return "contains a space or a control character";
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "is not an absolute URI";
	}
	if (url.hash !== "" || value.includes("#")) return "has a fragment";
	if (url.username !== "" || url.password !== "") return "has a user name or a password";
	if (REFUSED_SCHEMES.has(url.protocol) || REFUSED_SCHEME_PATTERN.test(url.protocol)) {
		return `uses the ${url.protocol} scheme`;
	}
	if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname))
		return "uses http: for a host that is not loopback";
	return null;
}

/** The part of a redirect URI that the person sees on the approval page: the host, or the scheme of an app. */
export function redirectHost(value: string): string {
	const url = new URL(value);
	if (url.protocol === "https:" || url.protocol === "http:") return url.host;
	return url.host ? `${url.protocol}//${url.host}` : url.protocol;
}

/** The redirect URI with the parameters added to its query. A null parameter is left out. */
export function redirectWith(value: string, params: Record<string, string | null>): string {
	const url = new URL(value);
	for (const [name, param] of Object.entries(params)) if (param !== null) url.searchParams.set(name, param);
	return url.toString();
}
