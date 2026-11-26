// What a command gets from the process. Tests give fakes.
import type { HttpGet } from "./http.ts";
import type { Prompter } from "./prompt.ts";

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
	sleep(ms: number): Promise<void>;
	now(): number;
}

/** Writes one line. */
export function say(ctx: Pick<Context, "io">, line = ""): void {
	ctx.io.out(`${line}\n`);
}
