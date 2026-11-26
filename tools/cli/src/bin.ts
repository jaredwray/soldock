#!/usr/bin/env node
// The `asterra` command. package.json `bin` points to the emitted dist/bin.js.
import { run } from "./cli.ts";

process.exitCode = run(process.argv.slice(2), {
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
});
