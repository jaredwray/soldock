import { api, errorMessage, isUnauthenticated } from "../../lib/api.ts";
import { getSetupStatus, type SetupNeeded } from "../setup/setup.ts";
import type { Whoami } from "./session.tsx";

export type SessionState =
	| { status: "loading" }
	| { status: "setup"; setup: SetupNeeded }
	| { status: "signed-out"; expired: boolean }
	| { status: "error"; message: string }
	| { status: "signed-in"; whoami: Whoami };

/** Checks setup before session authentication, so an old schema cannot hide recovery. */
export async function loadSession(showSetup = true): Promise<SessionState> {
	try {
		if (showSetup) {
			const setup = await getSetupStatus();
			if (setup.setup_needed) return { status: "setup", setup };
		}
		const whoami = await api.call("account.whoami");
		return { status: "signed-in", whoami };
	} catch (error) {
		return isUnauthenticated(error)
			? { status: "signed-out", expired: false }
			: { status: "error", message: errorMessage(error) };
	}
}
