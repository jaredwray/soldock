import type { ApiKey, Principal } from "@soldock/contracts";
import type { ApiKeyRecord, PrincipalRecord } from "./store.ts";

export function toPrincipalOutput(record: PrincipalRecord): Principal {
	return {
		id: record.id,
		kind: record.kind,
		display_name: record.display_name,
		address: record.address,
		org_role: record.org_role,
		sponsor_id: record.sponsor_id,
		outbound_policy:
			record.kind === "agent" && record.outbound_mode
				? { mode: record.outbound_mode, allowlist: record.outbound_allowlist }
				: null,
		created_at: record.created_at,
	};
}

export function toApiKeyOutput(record: ApiKeyRecord): ApiKey {
	return {
		id: record.id,
		principal_id: record.principal_id,
		label: record.label,
		scopes: record.scopes,
		created_at: record.created_at,
		last_used_at: record.last_used_at,
		revoked: record.revoked_at !== null,
	};
}
