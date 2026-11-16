import { plural, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { adminPath, sharedDrivePath } from "../../routes.ts";
import type { SharedDrivesState } from "./data.ts";
import { SHARED_DRIVE_ICON } from "./model.ts";
import { ROLE_NAMES } from "./sharedDrives.ts";

interface SharedDriveListProps {
	state: SharedDrivesState;
	/** True for an owner or an admin, who creates shared drives on the Admin page. */
	orgAdmin: boolean;
}

/** The shared drives of the person, as a table: the name, the role of the person and the number of members. */
export function SharedDriveList({ state, orgAdmin }: SharedDriveListProps) {
	const { drives, error } = state;
	if (drives === null && error === null) {
		return (
			<div className="list-state" aria-live="polite">
				<span className="spinner" aria-hidden="true" />
				Loading shared drives…
			</div>
		);
	}
	if (drives === null) {
		return (
			<div className="list-state" role="alert">
				<p>The shared drives did not load. {error}</p>
				<button type="button" className="button" onClick={() => void state.reload()}>
					Try again
				</button>
			</div>
		);
	}
	if (drives.length === 0) {
		return (
			<div className="list-state list-empty">
				<span className="drive-empty-tile">
					<Icon name={SHARED_DRIVE_ICON} size={24} />
				</span>
				<p>You are not a member of a shared drive.</p>
				{orgAdmin ? (
					<Link to={adminPath("shared-drives")} className="button">
						Create one in Admin
					</Link>
				) : (
					<p className="muted">An owner or an admin creates shared drives and adds their members.</p>
				)}
			</div>
		);
	}
	return (
		<>
			<table className="drive-table drive-table-drives" aria-label="Shared drives">
				<thead>
					<tr>
						<th scope="col">Name</th>
						<th scope="col" className="drive-col-owner">
							Your role
						</th>
						<th scope="col" className="drive-col-modified">
							Members
						</th>
						<th scope="col" className="drive-col-size">
							Created
						</th>
					</tr>
				</thead>
				<tbody>
					{drives.map((drive) => (
						<tr key={drive.id} className="drive-row">
							<th scope="row" className="drive-col-name">
								<span className="drive-name">
									<Link to={sharedDrivePath(drive.id)} className="drive-name-link">
										<span className="drive-kind drive-kind-folder">
											<Icon name={SHARED_DRIVE_ICON} size={18} />
										</span>
										<span className="drive-name-text">{drive.name}</span>
										<span className="visually-hidden">, shared drive</span>
									</Link>
								</span>
							</th>
							<td className="drive-col-owner">{drive.role ? ROLE_NAMES[drive.role] : ""}</td>
							<td className="drive-col-modified">{plural(drive.member_count, "member")}</td>
							<td className="drive-col-size">
								<time dateTime={drive.created_at}>{shortDate(drive.created_at)}</time>
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<div className="list-footer">
				<span className="muted">{plural(drives.length, "shared drive")}</span>
				{orgAdmin && (
					<Link to={adminPath("shared-drives")} className="link-button">
						Manage shared drives in Admin
					</Link>
				)}
			</div>
		</>
	);
}
