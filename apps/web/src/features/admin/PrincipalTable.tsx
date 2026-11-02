import type { Principal } from "@soldock/contracts";
import { policySummary } from "./policy.ts";

const ROLE_NAMES = { owner: "Owner", admin: "Admin", member: "Member" } as const;

export function PrincipalTable({ principals }: { principals: readonly Principal[] }) {
	const byId = new Map(principals.map((p) => [p.id, p]));
	const sorted = [...principals].sort(
		(a, b) => a.kind.localeCompare(b.kind) || a.display_name.localeCompare(b.display_name),
	);
	return (
		<section className="card">
			<h2 className="card-title">People and agents</h2>
			<div className="table-scroll">
				<table className="table">
					<caption className="visually-hidden">People and agents of the organization</caption>
					<thead>
						<tr>
							<th scope="col">Kind</th>
							<th scope="col">Name</th>
							<th scope="col">Address</th>
							<th scope="col">Role</th>
							<th scope="col">Sponsor</th>
							<th scope="col">Agent policy</th>
						</tr>
					</thead>
					<tbody>
						{sorted.map((principal) => (
							<tr key={principal.id}>
								<td>
									<span className={`kind kind-${principal.kind}`}>
										{principal.kind === "agent" ? "Agent" : "Person"}
									</span>
								</td>
								<td>{principal.display_name}</td>
								<td className="cell-address">{principal.address}</td>
								<td>{principal.org_role ? ROLE_NAMES[principal.org_role] : "—"}</td>
								<td>{principal.sponsor_id ? (byId.get(principal.sponsor_id)?.display_name ?? "Unknown") : "—"}</td>
								<td>{principal.outbound_policy ? policySummary(principal.outbound_policy) : "—"}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}
