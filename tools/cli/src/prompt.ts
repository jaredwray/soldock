// Questions to the operator. A run without a terminal, or with --yes, asks nothing: it takes the
// answer "yes", uses the default of a question, and stops when a question has no default.
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { Refusal } from "./errors.ts";

export interface TextQuestion {
	default?: string;
	/** The flag that gives the answer in a run without questions. */
	flag: string;
	validate?: (answer: string) => string | null;
}

export interface Choice<T> {
	label: string;
	value: T;
}

export interface Prompter {
	readonly interactive: boolean;
	confirm(question: string, fallback: boolean): Promise<boolean>;
	text(question: string, options: TextQuestion): Promise<string>;
	/** Like `text`, but the terminal does not show the answer. */
	secret(question: string, options: TextQuestion): Promise<string>;
	choose<T>(question: string, choices: readonly Choice<T>[], flag: string): Promise<T>;
}

/** The prompter of a run without questions. */
export const noQuestions: Prompter = {
	interactive: false,
	confirm: async () => true,
	text: async (question, { default: fallback, flag, validate }) => {
		if (fallback === undefined) throw new Refusal(`${question} Give the answer with ${flag}.`);
		const error = validate?.(fallback);
		if (error) throw new Refusal(`${flag}: ${error}`);
		return fallback;
	},
	secret: async (question, { flag }) => {
		throw new Refusal(`${question} Give the answer with ${flag}.`);
	},
	choose: async (question, choices, flag) => {
		const [only] = choices;
		if (choices.length === 1 && only) return only.value;
		throw new Refusal(`${question} Give the answer with ${flag}.`);
	},
};

/** Asks on the terminal. */
export function terminalPrompter(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Prompter {
	let muted = false;
	const sink = new Writable({
		write(chunk, _encoding, done) {
			if (!muted) output.write(chunk);
			done();
		},
	});
	const ask = async (question: string, hidden = false): Promise<string> => {
		const lines = createInterface({ input, output: sink, terminal: true });
		try {
			const pending = lines.question(question);
			muted = hidden;
			return (await pending).trim();
		} finally {
			muted = false;
			if (hidden) output.write("\n");
			lines.close();
		}
	};
	const askText = async (question: string, options: TextQuestion, hidden: boolean): Promise<string> => {
		for (;;) {
			const suffix = options.default === undefined ? "" : ` [${options.default}]`;
			const answer = (await ask(`${question}${suffix} `, hidden)) || (options.default ?? "");
			const error = answer === "" ? "An answer is necessary." : (options.validate?.(answer) ?? null);
			if (error === null) return answer;
			output.write(`${error}\n`);
		}
	};
	return {
		interactive: true,
		confirm: async (question, fallback) => {
			const answer = (await ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
			return answer === "" ? fallback : answer === "y" || answer === "yes";
		},
		text: (question, options) => askText(question, options, false),
		secret: (question, options) => askText(question, options, true),
		choose: async (question, choices) => {
			output.write(`${question}\n`);
			choices.forEach((choice, index) => {
				output.write(`  ${index + 1}. ${choice.label}\n`);
			});
			for (;;) {
				const index = Number(await ask(`Number (1-${choices.length}): `)) - 1;
				const choice = choices[index];
				if (choice) return choice.value;
			}
		},
	};
}
