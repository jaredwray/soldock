import type { OutputOf } from "@asterra/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";

export type AgentAccess = OutputOf<"directory.get_agent_access">;

export interface AgentAccessState {
	/** The access of the agent. Null until its first read. */
	access: AgentAccess | null;
	/** Why the last read failed, or null. */
	error: string | null;
	/** Reads the access again, for example after a change of a key. */
	reload: () => void;
	/** Shows the scopes and the limits of a save at once. A read that started before the save is then too old. */
	applySaved: (saved: OutputOf<"directory.set_agent_access">) => void;
}

/**
 * The access of one agent or service account (`directory.get_agent_access`). One read gives the
 * Permissions part its scopes and limits, and the Access part its lists.
 */
export function useAgentAccess(principalId: string): AgentAccessState {
	const [access, setAccess] = useState<AgentAccess | null>(null);
	const [error, setError] = useState<string | null>(null);
	// The number of the newest read. An answer of an older read must not replace a newer one: a key change
	// and a save of the permissions can each start a read.
	const newestRead = useRef(0);
	const load = useCallback(async () => {
		newestRead.current += 1;
		const read = newestRead.current;
		setError(null);
		try {
			const loaded = await api.call("directory.get_agent_access", { principal_id: principalId });
			if (read === newestRead.current) setAccess(loaded);
		} catch (caught) {
			if (read === newestRead.current) setError(errorMessage(caught));
		}
	}, [principalId]);
	useEffect(() => {
		void load();
	}, [load]);
	const reload = useCallback(() => void load(), [load]);
	const applySaved = useCallback((saved: OutputOf<"directory.set_agent_access">) => {
		newestRead.current += 1;
		setAccess((current) =>
			current === null ? current : { ...current, scopes: saved.scopes, resources: saved.resources },
		);
	}, []);
	return { access, error, reload, applySaved };
}
