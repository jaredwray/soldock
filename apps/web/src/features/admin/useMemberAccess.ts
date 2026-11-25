import type { OutputOf } from "@asterra/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";

export type MemberAccessData = OutputOf<"directory.get_member_access">;

export interface MemberAccessState {
	/** The access of the member. Null until its first read. */
	access: MemberAccessData | null;
	/** Why the last read failed, or null. */
	error: string | null;
	/** Reads the access again, for example after a change of a key. */
	reload: () => void;
}

/** The access of one person, agent or service account (`directory.get_member_access`), for the Access part. */
export function useMemberAccess(principalId: string): MemberAccessState {
	const [access, setAccess] = useState<MemberAccessData | null>(null);
	const [error, setError] = useState<string | null>(null);
	// The number of the newest read. An answer of an older read must not replace a newer one: a key change
	// and an approval of a member request can each start a read.
	const newestRead = useRef(0);
	const load = useCallback(async () => {
		newestRead.current += 1;
		const read = newestRead.current;
		setError(null);
		try {
			const loaded = await api.call("directory.get_member_access", { principal_id: principalId });
			if (read === newestRead.current) setAccess(loaded);
		} catch (caught) {
			if (read === newestRead.current) setError(errorMessage(caught));
		}
	}, [principalId]);
	useEffect(() => {
		void load();
	}, [load]);
	const reload = useCallback(() => void load(), [load]);
	return { access, error, reload };
}
