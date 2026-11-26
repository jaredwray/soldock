#!/usr/bin/env node
// The `asterra` command. package.json `bin` points to the emitted dist/bin.js.
import { run } from "./cli.ts";
import { httpGet } from "./http.ts";
import { noQuestions, terminalPrompter } from "./prompt.ts";

const io = {
	out: (text: string) => process.stdout.write(text),
	err: (text: string) => process.stderr.write(text),
};

process.exitCode = await run(process.argv.slice(2), io, (flags) => ({
	io,
	// Questions only on a terminal, and never with --yes.
	prompt:
		flags.yes || !process.stdin.isTTY || !process.stdout.isTTY
			? noQuestions
			: terminalPrompter(process.stdin, process.stdout),
	httpGet,
	fetch: globalThis.fetch,
	env: process.env,
	sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
	now: () => Date.now(),
}));
