import type { OutputOf } from "@soldock/contracts";
import { createContext, useContext } from "react";

export type Whoami = OutputOf<"account.whoami">;

export interface Session {
	whoami: Whoami;
	signOut: () => Promise<void>;
	/** Gets `account.whoami` again, after a change to the account. A failure keeps the old value and throws. */
	refresh: () => Promise<void>;
}

export const SessionContext = createContext<Session | null>(null);

/** The signed-in person. Use it only below the signed-in app. */
export function useSession(): Session {
	const session = useContext(SessionContext);
	if (!session) throw new Error("useSession needs a signed-in SessionContext");
	return session;
}

export function isOrgAdmin(principal: Whoami["principal"]): boolean {
	return principal.org_role === "owner" || principal.org_role === "admin";
}
