import type { Principal } from "@asterra/contracts";
import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { isOrgAdmin } from "../auth/session.tsx";

/**
 * True when the person sponsors an agent. The list of one sponsor with a limit of 1 is one bounded read:
 * each page of the app asks this, so it must not read the directory. The kind keeps a service account
 * out: its sponsor manages nothing, so the admin page would be empty.
 */
export async function sponsorsAgent(principalId: string): Promise<boolean> {
	const page = await api.call("directory.list_principals", { sponsor_id: principalId, kind: "agent", limit: 1 });
	return page.principals.length > 0;
}

/**
 * True when the person can open the admin page. Owners and admins can. A member can when the member
 * sponsors at least one agent, because a sponsor manages the policy and the keys of those agents.
 */
export function useAdminAccess(principal: Principal): boolean {
	const elevated = isOrgAdmin(principal);
	const [sponsor, setSponsor] = useState(false);

	useEffect(() => {
		if (elevated) return;
		let active = true;
		sponsorsAgent(principal.id).then(
			(sponsors) => {
				if (active) setSponsor(sponsors);
			},
			() => {
				// Without the answer, the link stays hidden. The admin page itself shows the error.
			},
		);
		return () => {
			active = false;
		};
	}, [elevated, principal.id]);

	return elevated || sponsor;
}
