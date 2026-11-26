import { CALENDAR_LIMITS, type CalendarAccess, type CalendarGrant } from "@asterra/contracts";
import { useEffect, useId, useMemo, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { Select, type SelectOption } from "../../lib/Select.tsx";
import { useToast } from "../../lib/toast.tsx";
import { principalOption, usePrincipals } from "../../lib/usePrincipals.ts";
import { useSession } from "../auth/session.tsx";
import { listGrants, removeGrant, setGrant } from "./data.ts";

const ACCESS: readonly SelectOption<CalendarAccess>[] = [
	{ value: "free_busy", label: "See when I am busy" },
	{ value: "schedule", label: "Schedule for me" },
];

/**
 * The grants of the own calendar of the person (`calendar.list_grants`, `calendar.set_grant` and
 * `calendar.remove_grant`). The person decides who sees the busy times and who schedules for them. This is in
 * Calendar, not in the settings of the members of the organization: only the person gives access to the own
 * calendar.
 */
export function CalendarSharing({ onClose }: { onClose: () => void }) {
	const toast = useToast();
	const selfId = useSession().whoami.principal.id;
	const principals = usePrincipals();
	const [grants, setGrants] = useState<CalendarGrant[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [newPrincipal, setNewPrincipal] = useState("");
	const [newAccess, setNewAccess] = useState<CalendarAccess>("free_busy");
	const ids = { who: useId(), access: useId() };

	useEffect(() => {
		let active = true;
		listGrants().then(
			(result) => active && setGrants(result.grants),
			(caught) => active && setError(errorMessage(caught)),
		);
		return () => {
			active = false;
		};
	}, []);

	const byId = useMemo(
		() => new Map((principals ?? []).map((principal) => [principal.id, principal] as const)),
		[principals],
	);
	const options = useMemo(
		() =>
			(principals ?? [])
				.filter((principal) => principal.id !== selfId && !grants?.some((grant) => grant.principal_id === principal.id))
				.map(principalOption),
		[principals, selfId, grants],
	);

	async function run(action: () => Promise<{ grants: CalendarGrant[] }>, message: string) {
		setBusy(true);
		setError(null);
		try {
			setGrants((await action()).grants);
			toast({ message });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	const nameOf = (id: string) => {
		const principal = byId.get(id);
		return principal ? (principalOption(principal).label as string) : id;
	};

	return (
		<Dialog title="Share your calendar" onClose={() => !busy && onClose()} className="cal-dialog">
			<div className="dialog-body cal-form">
				<p className="field-hint">
					A person or an agent that schedules for you adds events to your calendar and invites people from it. You are
					the organizer. It sees the time of each event, and the title of an event that is not private. It also sees the
					busy times that other people share with you. It sees no description, location or attendees of an event that it
					did not add.
				</p>
				{grants === null ? (
					error ? (
						<p className="form-error" role="alert">
							{error}
						</p>
					) : (
						<p className="field-hint">Loading the access…</p>
					)
				) : (
					<>
						{grants.length === 0 ? (
							<p className="field-hint">Only you can see your calendar. Add a person or an agent here.</p>
						) : (
							<ul className="cal-grants" aria-label="People and agents with access">
								{grants.map((grant) => {
									const name = nameOf(grant.principal_id);
									return (
										<li key={grant.principal_id} className="cal-grant">
											<span className="cal-grant-name">{name}</span>
											<Select
												label={`Access of ${name}`}
												value={grant.access}
												options={ACCESS}
												disabled={busy}
												onChange={(access) =>
													void run(
														() => setGrant({ principal_id: grant.principal_id, access }),
														`The access of ${name} changed.`,
													)
												}
											/>
											<button
												type="button"
												className="button button-danger-outline button-small"
												disabled={busy}
												aria-label={`Remove the access of ${name}`}
												onClick={() => void run(() => removeGrant(grant.principal_id), `The access of ${name} ended.`)}
											>
												Remove
											</button>
										</li>
									);
								})}
							</ul>
						)}
						{grants.length < CALENDAR_LIMITS.grants && (
							<fieldset className="cal-grant-add">
								<legend className="field-label">Give access</legend>
								<label className="visually-hidden" htmlFor={ids.who}>
									Person or agent
								</label>
								<Select
									id={ids.who}
									value={newPrincipal}
									options={options}
									placeholder={principals === null ? "Loading people…" : "Choose a person or an agent"}
									disabled={busy || principals === null}
									onChange={setNewPrincipal}
								/>
								<label className="visually-hidden" htmlFor={ids.access}>
									Access
								</label>
								<Select id={ids.access} value={newAccess} options={ACCESS} disabled={busy} onChange={setNewAccess} />
								<button
									type="button"
									className="button button-primary"
									disabled={busy || newPrincipal === ""}
									onClick={() => {
										const id = newPrincipal;
										void run(
											async () => {
												const result = await setGrant({ principal_id: id, access: newAccess });
												setNewPrincipal("");
												return result;
											},
											`${nameOf(id)} has access now.`,
										);
									}}
								>
									Give access
								</button>
							</fieldset>
						)}
						{error && (
							<p className="form-error" role="alert">
								{error}
							</p>
						)}
					</>
				)}
				<div className="dialog-actions">
					<span className="toolbar-spacer" />
					<button type="button" className="button" disabled={busy} onClick={onClose}>
						Done
					</button>
				</div>
			</div>
		</Dialog>
	);
}
