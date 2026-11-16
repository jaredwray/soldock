import type { Principal } from "@soldock/contracts";
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { SelectOption } from "./Select.tsx";

/** A person or an agent as an option of a `Select`: the name, "(agent)" for an agent, and the address. */
export function principalOption(principal: Principal): SelectOption<string> {
	return {
		value: principal.id,
		label: principal.kind === "agent" ? `${principal.display_name} (agent)` : principal.display_name,
		description: principal.address,
	};
}

/**
 * The people and agents of the organization. Drive shows the name of an owner and offers them in the
 * share dialog. Chat offers them as members and for a direct message. Null while the list loads. An
 * empty list when it does not load.
 */
export function usePrincipals(): Principal[] | null {
	const [principals, setPrincipals] = useState<Principal[] | null>(null);

	useEffect(() => {
		let active = true;
		api.call("directory.list_principals").then(
			(result) => {
				if (active) setPrincipals(result.principals);
			},
			() => {
				if (active) setPrincipals([]);
			},
		);
		return () => {
			active = false;
		};
	}, []);

	return principals;
}
