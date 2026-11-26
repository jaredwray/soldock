// What a command gets from the process. Tests give fakes.
import type { HttpGet } from "./http.ts";
import type { Prompter } from "./prompt.ts";
import type { Installer } from "./wrangler.ts";

/** Where the CLI writes. */
export interface Output {
	out(text: string): void;
	err(text: string): void;
}

export interface Context {
	io: Output;
	prompt: Prompter;
	/** GET with the headers as given (a browser navigation needs `Sec-Fetch-Mode: navigate`). */
	httpGet: HttpGet;
	/** For JSON calls to the Worker and to the GitHub API. */
	fetch: typeof fetch;
	env: Readonly<Record<string, string | undefined>>;
	/** The DNS records of a host (addresses and aliases). An empty list when the host has none. */
	resolveHost(hostname: string): Promise<string[]>;
	/** Installs wrangler into the cache folder of the CLI. */
	installWrangler: Installer;
	sleep(ms: number): Promise<void>;
	now(): number;
}

/** Writes one line. */
export function say(ctx: Pick<Context, "io">, line = ""): void {
	ctx.io.out(`${line}\n`);
}
