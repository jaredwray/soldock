import type { ApiKey, Principal } from "@asterra/contracts";
import { type ApiKeyRecord, keyExpired, type PrincipalRecord } from "./store.ts";

/** The kind of a principal in the directory and in `account.whoami`: a service account is `service`. */
export function principalKindOf(record: Pick<PrincipalRecord, "kind" | "service">): Principal["kind"] {
	return record.service ? "service" : record.kind;
}

export function toPrincipalOutput(record: PrincipalRecord): Principal {
	return {
		id: record.id,
		kind: principalKindOf(record),
		display_name: record.display_name,
		address: record.address,
		org_role: record.org_role,
		sponsor_id: record.sponsor_id,
		outbound_policy:
			record.kind === "agent" && record.outbound_mode
				? { mode: record.outbound_mode, allowlist: record.outbound_allowlist }
				: null,
		created_at: record.created_at,
		archived_at: record.archived_at,
		description: record.description,
		created_by: record.created_by,
	};
}

export function toApiKeyOutput(record: ApiKeyRecord): ApiKey {
	return {
		id: record.id,
		principal_id: record.principal_id,
		label: record.label,
		description: record.description,
		scopes: record.scopes,
		created_by: record.created_by,
		created_at: record.created_at,
		last_used_at: record.last_used_at,
		expires_at: record.expires_at,
		expired: keyExpired(record),
		revoked: record.revoked_at !== null,
		revoked_at: record.revoked_at,
		revoked_by: record.revoked_by,
	};
}
