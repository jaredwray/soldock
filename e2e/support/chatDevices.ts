import { type BrowserContext, test as base } from "@playwright/test";
import { type Person, signIn } from "./chat.ts";

/** Close each device opened by this test, including a context whose sign-in failed. */
export const test = base.extend<{ device(person: Person): Promise<BrowserContext> }>({
	device: async ({ browser }, use) => {
		const earlier = new Set(browser.contexts());
		try {
			await use((person) => signIn(browser, person));
		} finally {
			await Promise.all(
				browser
					.contexts()
					.filter((context) => !earlier.has(context))
					.map((context) => context.close()),
			);
		}
	},
});
