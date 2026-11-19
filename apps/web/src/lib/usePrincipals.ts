import { DIRECTORY_LIMITS, type DirectoryEntry, type Principal } from "@asterra/contracts";
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

/** The read of the directory that runs now. The views that need the directory at the same time share it. */
let reading: Promise<DirectoryEntry[]> | null = null;

/**
 * Each person and agent of the organization: each page of `directory.list_principals`, in the order of
 * the server. The pages have the largest size, so a small organization needs one call. A call while a
 * read runs gets that read. The pages are not one snapshot: a principal that changes its name between
 * two pages can come two times, so the list keeps the first one.
 *
 * `fresh` starts a new read, also while a read runs: a caller that just changed the directory needs
 * the change. The calls after it share the new read.
 */
export function listAllPrincipals(options: { fresh?: boolean } = {}): Promise<DirectoryEntry[]> {
	if (options.fresh || reading === null) {
		const read = readAllPages().finally(() => {
			if (reading === read) reading = null;
		});
		reading = read;
	}
	return reading;
}

async function readAllPages(): Promise<DirectoryEntry[]> {
	const all = new Map<string, DirectoryEntry>();
	let cursor: string | null = null;
	do {
		const page: { principals: DirectoryEntry[]; next_cursor: string | null } = await api.call(
			"directory.list_principals",
			cursor === null ? { limit: DIRECTORY_LIMITS.pageSize } : { limit: DIRECTORY_LIMITS.pageSize, cursor },
		);
		for (const principal of page.principals) if (!all.has(principal.id)) all.set(principal.id, principal);
		cursor = page.next_cursor;
	} while (cursor !== null);
	return [...all.values()];
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
