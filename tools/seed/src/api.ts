// The connection from the seed to Asterra. The seed uses only the public surface: the setup ceremony,
// the sign-in of the web app, the REST operations of `@asterra/contracts`, and the local inbound mail endpoint of `wrangler dev`.
import {
	ApiError,
	createClient,
	type InputOf,
	type OperationName,
	type OutputOf,
	operations,
	SetupInput,
	type SetupResult,
	SignInResult,
} from "@asterra/contracts";

/** The seed stopped before it changed anything, for a reason that the operator can correct. */
export class SeedStop extends Error {}

/** One raw message for one recipient, as an outside mail server delivers it. */
export interface Delivery {
	from: string;
	to: string;
	raw: string;
}

export interface SeedApi {
	/** `POST /auth/setup`: creates the owner. It fails with the code `conflict` if an owner exists. */
	setup(input: SetupInput): Promise<SetupResult>;
	/**
	 * Signs a person in with the address and the password, as the web app does, and creates an API key with
	 * the given scopes in that session. Setup creates no API key, so the seed gets the key of the owner here.
	 */
	ownKey(address: string, password: string, scopes: readonly string[]): Promise<string>;
	/** Calls one operation with the API key of a person or an agent. */
	call<N extends OperationName>(apiKey: string, name: N, input: InputOf<N>): Promise<OutputOf<N>>;
	/** Posts a raw message to the local inbound mail endpoint. */
	deliver(delivery: Delivery): Promise<void>;
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1"];

/**
 * Returns the origin of a local Worker. The seed creates accounts with passwords that everybody
 * knows, so it refuses each host that is not this computer.
 */
export function localOrigin(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new SeedStop(`"${url}" is not a URL. Use a URL such as http://localhost:8787.`);
	}
	if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !LOCAL_HOSTS.includes(parsed.hostname)) {
		throw new SeedStop(
			`The seed refuses ${url}. It creates accounts with known passwords, so it runs only against localhost or 127.0.0.1.`,
		);
	}
	return parsed.origin;
}

const RETRIES = 2;

/** A retry is safe for a read, and for a change that has an idempotency key. */
function isRetrySafe(name: OperationName, input: object): boolean {
	return operations[name].http.method === "GET" || "idempotency_key" in input;
}

function isTransient(error: unknown): boolean {
	return !(error instanceof ApiError) || error.status >= 500;
}

export function createHttpApi(origin: string, setupToken: string): SeedApi {
	const clients = new Map<string, ReturnType<typeof createClient>>();
	function clientFor(apiKey: string) {
		let client = clients.get(apiKey);
		if (!client) {
			client = createClient({ baseUrl: origin, headers: () => ({ authorization: `Bearer ${apiKey}` }) });
			clients.set(apiKey, client);
		}
		return client;
	}

	return {
		async setup(input) {
			const response = await fetch(`${origin}/auth/setup`, {
				method: "POST",
				headers: { authorization: `Bearer ${setupToken}`, "content-type": "application/json" },
				body: JSON.stringify(SetupInput.parse(input)),
			});
			const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
			if (!response.ok) throw new ApiError(response.status, body);
			return body as SetupResult;
		},

		async ownKey(address, password, scopes) {
			// The sign-in route and a call with the session cookie need the Origin header of this origin.
			const response = await fetch(`${origin}/auth/session`, {
				method: "POST",
				headers: { origin, "content-type": "application/json" },
				body: JSON.stringify({ address, password }),
			});
			const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
			if (!response.ok) throw new ApiError(response.status, body);
			const result = SignInResult.safeParse(body);
			if (!result.success || result.data.status !== "signed_in") {
				throw new Error(`The sign-in of ${address} did not give a session.`);
			}
			const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
			const session = createClient({ baseUrl: origin, headers: () => ({ cookie, origin }) });
			const created = await session.call("account.create_api_key", { label: "Seed", scopes: [...scopes] as never });
			return created.api_key.secret;
		},

		async call(apiKey, name, input) {
			// The server does the same check. This one names the operation, which helps to find a wrong body.
			const checked = operations[name].input.safeParse(input);
			if (!checked.success) throw new Error(`${name}: the seed made an invalid input: ${checked.error.message}`);
			const call = clientFor(apiKey).call as (name: OperationName, input: unknown) => Promise<unknown>;
			for (let attempt = 0; ; attempt++) {
				try {
					return (await call(name, input)) as OutputOf<typeof name>;
				} catch (error) {
					if (attempt >= RETRIES || !isRetrySafe(name, input) || !isTransient(error)) {
						if (error instanceof ApiError) error.message = `${name}: ${error.message}`;
						throw error;
					}
					await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
				}
			}
		},

		async deliver({ from, to, raw }) {
			const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
			const response = await fetch(`${origin}/cdn-cgi/local/email?${query}`, { method: "POST", body: raw });
			if (!response.ok) {
				throw new Error(
					`The local inbound mail endpoint returned HTTP ${response.status}. It exists only in wrangler dev.`,
				);
			}
		},
	};
}
