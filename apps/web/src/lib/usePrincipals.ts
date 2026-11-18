import { DIRECTORY_LIMITS, type DirectoryEntry, type Principal } from "@soldock/contracts";
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
 * Each person and agent of the organization: each page of `directory.list_principals`, in the order of
 * the server. The pages have the largest size, so a small organization needs one call.
 */
export async function listAllPrincipals(): Promise<DirectoryEntry[]> {
	const all: DirectoryEntry[] = [];
	let cursor: string | null = null;
	do {
		const page: { principals: DirectoryEntry[]; next_cursor: string | null } = await api.call(
			"directory.list_principals",
			cursor === null ? { limit: DIRECTORY_LIMITS.pageSize } : { limit: DIRECTORY_LIMITS.pageSize, cursor },
		);
		all.push(...page.principals);
		cursor = page.next_cursor;
	} while (cursor !== null);
	return all;
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
		listAllPrincipals().then(
			(principals) => {
				if (active) setPrincipals(principals);
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
