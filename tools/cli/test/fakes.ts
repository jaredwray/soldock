// Fakes of the process boundaries of the CLI: the terminal, wrangler and HTTP.
import type { Context } from "../src/context.ts";
import type { HttpGet } from "../src/http.ts";
import { noQuestions, type Prompter } from "../src/prompt.ts";
import type { RunOptions, RunResult, Wrangler } from "../src/wrangler.ts";

export interface Call {
	args: string[];
	options: RunOptions;
}

export type FakeWrangler = Wrangler & { calls: Call[] };

/** A wrangler that answers each command with `answer`. */
export function fakeWrangler(
	answer: (args: string[], options: RunOptions) => Partial<RunResult> | undefined,
): FakeWrangler {
	const calls: Call[] = [];
	return {
		version: "4.149.0",
		calls,
		run: async (args, options = {}) => {
			calls.push({ args: [...args], options });
			return { code: 0, stdout: "", stderr: "", ...answer([...args], options) };
		},
	};
}

/** True when the call starts with these words. */
export const starts = (args: readonly string[], ...words: string[]) =>
	words.every((word, index) => args[index] === word);

export type ScriptedPrompter = Prompter & { asked: string[] };

/** A terminal that gives the answers in order. A question without an answer fails the test. */
export function scripted(answers: Array<boolean | string | number>): ScriptedPrompter {
	const queue = [...answers];
	const asked: string[] = [];
	const next = (question: string) => {
		asked.push(question);
		if (queue.length === 0) throw new Error(`No answer for: ${question}`);
		return queue.shift();
	};
	return {
		interactive: true,
		asked,
		confirm: async (question) => next(question) as boolean,
		text: async (question) => next(question) as string,
		secret: async (question) => next(question) as string,
		choose: async (question, choices) => {
			const choice = choices[next(question) as number];
			if (!choice) throw new Error(`No choice for: ${question}`);
			return choice.value;
		},
	};
}

export interface FakeContext extends Context {
	output(): string;
	errors(): string;
}

export function fakeContext(overrides: Partial<Context> = {}): FakeContext {
	let out = "";
	let err = "";
	let clock = 1_000_000;
	const httpGet: HttpGet = async (url) => {
		throw new Error(`no HTTP fake for ${url}`);
	};
	return {
		io: {
			out: (text) => {
				out += text;
			},
			err: (text) => {
				err += text;
			},
		},
		prompt: noQuestions,
		httpGet,
		fetch: async (input) => {
			throw new Error(`no fetch fake for ${String(input)}`);
		},
		env: {},
		sleep: async (ms) => {
			clock += ms;
		},
		now: () => clock,
		output: () => out,
		errors: () => err,
		...overrides,
	};
}
