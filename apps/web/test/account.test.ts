import { describe, expect, it } from "vitest";
import { accountChangeCount, currentAccount, onAccountChange, setAccount } from "../src/lib/account.ts";

describe("the person of the page", () => {
	// Work that waits for one person stops on each change. A call for no change would stop it for the same person.
	it("tells its listeners when the person changes, also to nobody, and not when the person stays", () => {
		const seen: (string | null)[] = [];
		const remove = onAccountChange(() => seen.push(currentAccount()));
		setAccount("prn_ada");
		// The app sets the same person again after each change of the account.
		setAccount("prn_ada");
		setAccount(null);
		setAccount("prn_bob");
		expect(seen).toEqual(["prn_ada", null, "prn_bob"]);
		remove();
		setAccount(null);
		expect(seen).toHaveLength(3);
	});

	// A person signs out and signs in again. Work from before the sign-out must know that.
	it("counts each change, so the same person after a sign-out is not the same sign-in", () => {
		setAccount("prn_ada");
		const signedIn = accountChangeCount();
		setAccount("prn_ada");
		expect(accountChangeCount()).toBe(signedIn);
		setAccount(null);
		setAccount("prn_ada");
		expect(accountChangeCount()).toBe(signedIn + 2);
	});
});
