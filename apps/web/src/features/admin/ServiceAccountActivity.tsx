import type { ApiKey, Principal, ServiceActivityEntry } from "@asterra/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fullDate, shortDate } from "../../lib/format.ts";
import { Select } from "../../lib/Select.tsx";

const RESULT_NAMES: Record<ServiceActivityEntry["result"], string> = {
	ok: "OK",
	denied: "Refused",
	error: "Failed",
};

const SURFACE_NAMES: Record<ServiceActivityEntry["surface"], string> = {
	rest: "REST",
	mcp: "MCP",
	admin: "Admin change",
	member: "Member change",
	system: "Asterra",
};

interface ServiceAccountActivityProps {
	account: Principal;
	/** The people of the directory, for the names of the admins who made a change. */
	principals: readonly Principal[];
	/** A new value loads the log again, for example after a token change. */
	version: number;
}

type LogState = { status: "loading" } | { status: "error"; error: string } | { status: "ready" };

/**
 * The activity log of a service account (`directory.list_service_account_activity`): each call of its
 * tokens through REST and MCP, and each change by an owner or an admin, with the newest first. A filter
 * keeps the entries of one token, and "Load more" reads the next page.
 */
export function ServiceAccountActivity({ account, principals, version }: ServiceAccountActivityProps) {
	const headingId = useId();
	const filterId = useId();
	const [keys, setKeys] = useState<ApiKey[]>([]);
	const [keyId, setKeyId] = useState("");
	const [entries, setEntries] = useState<ServiceActivityEntry[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [state, setState] = useState<LogState>({ status: "loading" });
	const [more, setMore] = useState(false);
	// A newer load replaces the answer of an older one, so a quick filter change shows the right entries.
	const generation = useRef(0);

	const load = useCallback(async () => {
		const current = ++generation.current;
		setState({ status: "loading" });
		try {
			const [page, listed] = await Promise.all([
				api.call("directory.list_service_account_activity", {
					principal_id: account.id,
					...(keyId ? { key_id: keyId } : {}),
				}),
				api.call("account.list_api_keys", { principal_id: account.id }),
			]);
			if (current !== generation.current) return;
			setEntries(page.entries);
			setCursor(page.next_cursor);
			setKeys(listed.api_keys);
			setState({ status: "ready" });
		} catch (caught) {
			if (current !== generation.current) return;
			setState({ status: "error", error: errorMessage(caught) });
		}
	}, [account.id, keyId]);

	useEffect(() => {
		void version;
		void load();
	}, [load, version]);

	async function loadMore() {
		if (!cursor) return;
		const current = generation.current;
		setMore(true);
		try {
			const page = await api.call("directory.list_service_account_activity", {
				principal_id: account.id,
				cursor,
				...(keyId ? { key_id: keyId } : {}),
			});
			if (current !== generation.current) return;
			setEntries((shown) => [...shown, ...page.entries]);
			setCursor(page.next_cursor);
		} catch (caught) {
			setState({ status: "error", error: errorMessage(caught) });
		} finally {
			setMore(false);
		}
	}

	const keyLabel = (id: string | null) =>
		id === null ? "—" : (keys.find((key) => key.id === id)?.label ?? "A removed token");
	const actorName = (entry: ServiceActivityEntry) =>
		entry.actor_id === account.id
			? account.display_name
			: (principals.find((principal) => principal.id === entry.actor_id)?.display_name ?? "A deleted member");

	return (
		<section aria-labelledby={headingId}>
			<div className="activity-head">
				<h2 id={headingId} className="subpanel-title">
					Activity
				</h2>
				<div className="activity-tools">
					<label htmlFor={filterId} className="visually-hidden">
						Token
					</label>
					<Select
						id={filterId}
						value={keyId}
						options={[
							{ value: "", label: "All tokens" },
							...keys.map((key) => ({ value: key.id, label: key.label, description: key.id })),
						]}
						onChange={setKeyId}
					/>
					<button type="button" className="button button-small" onClick={() => void load()}>
						Refresh
					</button>
				</div>
			</div>
			{state.status === "error" && (
				<div className="form-error" role="alert">
					<p>The activity did not load. {state.error}</p>
					<button type="button" className="button button-small" onClick={() => void load()}>
						Try again
					</button>
				</div>
			)}
			{state.status === "loading" && entries.length === 0 && <p className="panel-empty">Loading the activity…</p>}
			{state.status === "ready" && entries.length === 0 && (
				<p className="panel-empty">No activity yet. Calls with a token show here.</p>
			)}
			{entries.length > 0 && (
				<div className="table-scroll" aria-live="polite">
					<table className="table table-rows">
						<caption className="visually-hidden">Activity of {account.display_name}, newest first</caption>
						<thead>
							<tr>
								<th scope="col">Time</th>
								<th scope="col">Operation</th>
								<th scope="col">Result</th>
								<th scope="col" className="col-optional">
									Token
								</th>
								<th scope="col" className="col-optional">
									By
								</th>
							</tr>
						</thead>
						<tbody>
							{entries.map((entry) => (
								<tr key={entry.id}>
									<td className="cell-date" title={fullDate(entry.at)}>
										{shortDate(entry.at)}
									</td>
									<td>
										<code>{entry.operation}</code>
										<div className="row-note">
											{SURFACE_NAMES[entry.surface]}
											{entry.resource_id && entry.resource_id !== account.id ? ` · ${entry.resource_id}` : ""}
										</div>
									</td>
									<td>
										<span className={entry.result === "ok" ? "status" : "status status-failed"}>
											{RESULT_NAMES[entry.result]}
										</span>
										{entry.code && entry.result !== "ok" && <div className="row-note">{entry.code}</div>}
									</td>
									<td className="col-optional">{keyLabel(entry.key_id)}</td>
									<td className="col-optional">{actorName(entry)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{cursor && (
				<button type="button" className="button button-small" onClick={() => void loadMore()} disabled={more}>
					{more ? "Loading…" : "Load more"}
				</button>
			)}
		</section>
	);
}
