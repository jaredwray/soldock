import {
	addDays,
	CALENDAR_LIMITS,
	daysBetween,
	isRealDate,
	type OutputOf,
	type Principal,
	zonedDayStart,
} from "@asterra/contracts";
import { useId, useMemo, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { Select, type SelectOption } from "../../lib/Select.tsx";
import { findTimes } from "./data.ts";
import { intervalText } from "./model.ts";

type FindResult = OutputOf<"calendar.find_times">;

const DURATIONS: readonly SelectOption<string>[] = [15, 30, 45, 60, 90].map((minutes) => ({
	value: String(minutes),
	label: minutes < 60 ? `${minutes} minutes` : minutes === 60 ? "1 hour" : `${minutes / 60} hours`,
}));

/** Each IANA time zone of the browser, with the zone of the dialog first when the list does not have it. */
function zoneOptions(zone: string): SelectOption<string>[] {
	const names = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
	const all = names.includes(zone) ? names : [zone, ...names];
	return all.map((name) => ({ value: name, label: name.replaceAll("_", " ") }));
}

interface FindTimeProps {
	/** The principal ids of the attendees, without the person. */
	attendees: readonly string[];
	/** The people and agents of the organization, for the names. */
	principals: readonly Principal[];
	/** The id of the person: the first calendar of each answer. */
	selfId: string;
	/** The first day of the search. */
	startDate: string;
	/** The time zone of the dialog. The search starts in it. */
	zone: string;
	/** Called with the instants of the suggestion that the person chooses. */
	onPick: (start: number, end: number) => void;
}

/**
 * Find a time (`calendar.find_times`): the busy times of the person and of each attendee, and the free times
 * that the server suggests. A calendar that shares no availability shows "Availability unknown". The panel
 * never shows it as free, and it tells the person when a suggestion is free only for the known calendars.
 */
export function FindTime({ attendees, principals, selfId, startDate, zone, onPick }: FindTimeProps) {
	const [from, setFrom] = useState(startDate);
	const [to, setTo] = useState(() => addDays(startDate, 6));
	const [duration, setDuration] = useState("30");
	const [searchZone, setSearchZone] = useState(zone);
	const [result, setResult] = useState<{ answer: FindResult; zone: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const zones = useMemo(() => zoneOptions(zone), [zone]);
	const ids = { duration: useId(), zone: useId() };
	const names = useMemo(
		() => new Map(principals.map((principal) => [principal.id, principal.display_name])),
		[principals],
	);
	const nameOf = (id: string) => (id === selfId ? "You" : (names.get(id) ?? id));

	async function search() {
		if (!isRealDate(from) || !isRealDate(to)) {
			setError("Give a first and a last day.");
			return;
		}
		const days = daysBetween(from, to) + 1;
		if (days < 1) {
			setError("The last day must not be before the first day.");
			return;
		}
		if (days > CALENDAR_LIMITS.findRangeDays) {
			setError(`Search at most ${CALENDAR_LIMITS.findRangeDays} days at a time.`);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const answer = await findTimes({
				time_min: new Date(zonedDayStart(from, searchZone)).toISOString(),
				time_max: new Date(zonedDayStart(addDays(to, 1), searchZone)).toISOString(),
				duration_minutes: Number(duration),
				time_zone: searchZone,
				...(attendees.length > 0 ? { attendee_ids: attendees.join(",") } : {}),
			});
			setResult({ answer, zone: searchZone });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	const unknown = result?.answer.calendars.filter((calendar) => calendar.availability === "unknown") ?? [];

	return (
		<section className="cal-find" aria-label="Find a time">
			<div className="cal-find-fields">
				<label className="cal-find-field">
					<span className="field-label">From</span>
					<input className="input" type="date" value={from} onChange={(change) => setFrom(change.target.value)} />
				</label>
				<label className="cal-find-field">
					<span className="field-label">To</span>
					<input className="input" type="date" value={to} onChange={(change) => setTo(change.target.value)} />
				</label>
				<div className="cal-find-field">
					<label className="field-label" htmlFor={ids.duration}>
						Duration
					</label>
					<Select id={ids.duration} value={duration} options={DURATIONS} onChange={setDuration} />
				</div>
				<div className="cal-find-field cal-find-zone">
					<label className="field-label" htmlFor={ids.zone}>
						Time zone
					</label>
					<Select id={ids.zone} value={searchZone} options={zones} onChange={setSearchZone} />
				</div>
			</div>
			<p className="field-hint">Asterra suggests times from 9:00 AM to 5:00 PM on each day, in this time zone.</p>
			<div>
				<button type="button" className="button" disabled={busy} onClick={() => void search()}>
					{busy ? "Searching…" : "Find times"}
				</button>
			</div>
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			{result && (
				<div className="cal-find-result" aria-live="polite">
					<h3 className="cal-find-heading">Busy times</h3>
					<ul className="cal-find-calendars">
						{result.answer.calendars.map((calendar) => (
							<li key={calendar.principal_id} className="cal-find-calendar">
								<span className="cal-find-name">{nameOf(calendar.principal_id)}</span>
								{calendar.availability === "unknown" ? (
									<span className="cal-find-unknown">Availability unknown</span>
								) : calendar.busy.length === 0 ? (
									<span className="cal-find-free">No busy time</span>
								) : (
									<ul className="cal-find-busy" aria-label={`Busy times of ${nameOf(calendar.principal_id)}`}>
										{calendar.busy.map((interval) => (
											<li key={interval.start}>
												{intervalText(Date.parse(interval.start), Date.parse(interval.end), result.zone)}
											</li>
										))}
									</ul>
								)}
							</li>
						))}
					</ul>
					{unknown.length > 0 && (
						<p className="cal-find-warning" role="note">
							Asterra does not know when {unknown.map((calendar) => nameOf(calendar.principal_id)).join(", ")}{" "}
							{unknown.length === 1 ? "is" : "are"} free. The suggestions are free only for the other calendars.
						</p>
					)}
					<h3 className="cal-find-heading">Suggested times</h3>
					{result.answer.suggestions.length === 0 ? (
						<p className="field-hint">No free time of this length in these days. Try more days or a shorter meeting.</p>
					) : (
						<ul className="cal-find-slots">
							{result.answer.suggestions.map((slot) => (
								<li key={slot.start}>
									<button
										type="button"
										className="button button-small"
										onClick={() => onPick(Date.parse(slot.start), Date.parse(slot.end))}
									>
										{intervalText(Date.parse(slot.start), Date.parse(slot.end), result.zone)}
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</section>
	);
}
