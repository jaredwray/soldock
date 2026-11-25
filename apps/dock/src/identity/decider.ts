import { getPrincipal, type PrincipalRecord } from "./store.ts";

/**
 * The person who gets a request for this account in the activity list of Chat: a request of an agent to add
 * the account to a room, or to share an item with it. For an agent: its sponsor. Only an owner or an admin
 * manages a service account, so its sponsor gets the request only with one of these roles. If not, the owner
 * of the organization gets it. Each owner and admin also sees the request on the card of the account in Admin,
 * Members.
 */
export async function deciderOf(db: D1Database, target: PrincipalRecord): Promise<string | null> {
	if (target.sponsor_id !== null) {
		if (!target.service) return target.sponsor_id;
		const sponsor = await getPrincipal(db, target.sponsor_id);
		if (sponsor?.archived_at === null && (sponsor.org_role === "owner" || sponsor.org_role === "admin")) {
			return sponsor.id;
		}
	}
	const owner = await db
		.prepare(
			"SELECT id FROM principals WHERE org_role = 'owner' AND deleted_at IS NULL AND archived_at IS NULL LIMIT 1",
		)
		.first<{ id: string }>();
	return owner?.id ?? null;
}
