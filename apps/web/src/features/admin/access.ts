import type { Principal } from "@soldock/contracts";
import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { isOrgAdmin } from "../auth/session.tsx";

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
		api.call("directory.list_principals").then(
			(result) => {
				if (active) setSponsor(result.principals.some((p) => p.kind === "agent" && p.sponsor_id === principal.id));
			},
			() => {
				// Without the directory, the link stays hidden. The admin page itself shows the error.
			},
		);
		return () => {
			active = false;
		};
	}, [elevated, principal.id]);

	return elevated || sponsor;
}
