// Usage: node tools/seed/seed.ts [--url http://localhost:8787] [--setup-token <token>]
// Fills an empty local Soldock with a made-up organization, for demonstrations and screenshots.
import { parseArgs } from "node:util";
import { ApiError } from "@soldock/contracts";
import { createHttpApi, localOrigin, SeedStop } from "./src/api.ts";
import { runSeed, signInLines } from "./src/run.ts";

const USAGE = `Usage: pnpm seed [--url <url>] [--setup-token <token>]

Fills an empty local Soldock with a made-up organization.

  --url <url>            The local Worker. Default: http://localhost:8787
  --setup-token <token>  The SETUP_TOKEN of the Worker. Default: the SETUP_TOKEN environment variable
`;

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: { url: { type: "string" }, "setup-token": { type: "string" }, help: { type: "boolean", short: "h" } },
	});
	if (values.help) {
		console.log(USAGE);
		return;
	}
	const origin = localOrigin(values.url ?? "http://localhost:8787");
	const setupToken = values["setup-token"] ?? process.env.SETUP_TOKEN;
	if (!setupToken) {
		throw new SeedStop(
			"The seed needs the setup token of the Worker. Set the SETUP_TOKEN environment variable, or use --setup-token.",
		);
	}
	await runSeed(createHttpApi(origin, setupToken), { log: (line) => console.log(line) });
	console.log(`\n${signInLines(origin).join("\n")}`);
}

try {
	await main();
} catch (error) {
	// A stop, a refused URL and an API error have a message for the operator. Each other error is a
	// defect, so it shows with its stack.
	if (error instanceof SeedStop || error instanceof ApiError) console.error(`seed: ${error.message}`);
	else if (error instanceof TypeError && error.message === "fetch failed") {
		console.error("seed: the Worker did not answer. Start it first: see docs/development.md.");
	} else console.error(error);
	process.exitCode = 1;
}
