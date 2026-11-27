import "./calendar.css";
import { ApiError, type CalendarEvent, canonicalTimeZone, zonedDate } from "@asterra/contracts";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
import { setPageTitle } from "../../lib/pageTitle.ts";
import { Link, navigate } from "../../lib/router.tsx";
import { Select, type SelectOption } from "../../lib/Select.tsx";
import { usePrincipals } from "../../lib/usePrincipals.ts";
import { type CalendarView, calendarPath, isCalendarDate } from "../../routes.ts";
import { PageHeader } from "../../shell/PageHeader.tsx";
import { CalendarSharing } from "./CalendarSharing.tsx";
import { useEvents, useSharedCalendars } from "./data.ts";
import { EventDialog } from "./EventDialog.tsx";
import { clampDay, type EventForm, type FirstDay, newEventForm, periodOf, periodTitle, shiftTarget } from "./model.ts";
import { AgendaList, MonthView, WeekView } from "./views.tsx";

/** The first day of a week in the grid. The dates of the web app use en-US, which starts a week on Sunday. */
const FIRST_DAY: FirstDay = 0;

/** At this width and below, the views become a list of the days with events. */
const PHONE_QUERY = "(max-width: 600px)";

function useMediaQuery(query: string): boolean {
	return useSyncExternalStore(
		(onChange) => {
			const list = window.matchMedia(query);
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		},
		() => window.matchMedia(query).matches,
	);
}

/** The time zone of the browser. The calendar shows each day and each time in it. */
function browserZone(): string {
	return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC";
}

/** The date of today in a zone. It changes at midnight, so the page checks it each minute. */
function useToday(zone: string): string {
	const [today, setToday] = useState(() => zonedDate(Date.now(), zone));
	useEffect(() => {
		const timer = window.setInterval(() => setToday(zonedDate(Date.now(), zone)), 60_000);
		return () => window.clearInterval(timer);
	}, [zone]);
	return today;
}

interface CalendarAppProps {
	view: CalendarView;
	/** A day of the period to show, or null for today. */
	date: string | null;
	/** The person whose calendar the page shows, who lets the person schedule. Null for the own calendar. */
	calendarId: string | null;
}

type DialogState = { event: CalendarEvent | null; initial: EventForm } | null;

/** Calendar: the week or the month of a day, with the events of the own calendar of the person. */
export function CalendarApp({ view, date, calendarId }: CalendarAppProps) {
	const zone = useMemo(browserZone, []);
	const today = useToday(zone);
	const anchor = date ?? today;
	const period = useMemo(() => periodOf(view, anchor, zone, FIRST_DAY), [view, anchor, zone]);
	const { state, reload, retry } = useEvents(period.timeMin, period.timeMax, zone, calendarId);
	const shared = useSharedCalendars();
	const principals = usePrincipals();
	// The name of the owner: from the list of shared calendars, or from the directory while the list loads.
	const ownerName =
		calendarId === null
			? null
			: (shared.find((entry) => entry.calendar_id === calendarId)?.display_name ??
				principals?.find((principal) => principal.id === calendarId)?.display_name ??
				"this person");
	const calendarOptions: SelectOption<string>[] = [
		{ value: "", label: "My calendar" },
		...shared.map((entry) => ({ value: entry.calendar_id, label: entry.display_name })),
		...(calendarId !== null && !shared.some((entry) => entry.calendar_id === calendarId)
			? [{ value: calendarId, label: ownerName ?? calendarId }]
			: []),
	];
	const refused =
		calendarId !== null &&
		state.status === "error" &&
		state.error instanceof ApiError &&
		(state.error.code === "forbidden" || state.error.code === "not_found");
	const phone = useMediaQuery(PHONE_QUERY);
	const [dialog, setDialog] = useState<DialogState>(null);
	const [sharing, setSharing] = useState(false);
	const title = periodTitle(view, anchor, FIRST_DAY);
	const unit = view === "week" ? "week" : "month";

	useEffect(() => {
		setPageTitle(ownerName ? `${title} – Calendar of ${ownerName} – Asterra` : `${title} – Calendar – Asterra`);
	}, [title, ownerName]);

	const openEvent = useCallback((event: CalendarEvent) => setDialog({ event, initial: newEventForm(today) }), [today]);
	// The first and the last week show days before 1970 and after 2100. No event can use them.
	const createAt = useCallback((day: string, hour?: number) => {
		if (isCalendarDate(day)) setDialog({ event: null, initial: newEventForm(day, hour) });
	}, []);
	// A new event in the period of today starts today. In a different period, it starts on its first day.
	const newEventDay = clampDay(
		period.days.includes(today) && (view === "week" || today.slice(0, 7) === anchor.slice(0, 7))
			? today
			: view === "week"
				? period.start
				: `${anchor.slice(0, 7)}-01`,
	);

	const month = anchor.slice(0, 7);
	const agendaDays = view === "month" ? period.days.filter((day) => day.slice(0, 7) === month) : period.days;

	return (
		<main id="main" className="page-main cal-main" tabIndex={-1}>
			<PageHeader title="Calendar" icon="calendar">
				{calendarId === null && (
					<button type="button" className="button" onClick={() => setSharing(true)}>
						Sharing
					</button>
				)}
				<button type="button" className="button button-primary" onClick={() => createAt(newEventDay)}>
					<Icon name="plus" />
					New event
				</button>
			</PageHeader>
			<div className="toolbar cal-toolbar">
				{calendarOptions.length > 1 && (
					<Select<string>
						label="Calendar"
						value={calendarId ?? ""}
						options={calendarOptions}
						onChange={(id) => navigate(calendarPath(view, anchor, id === "" ? null : id))}
					/>
				)}
				<Link to={calendarPath(view, today, calendarId)} className="button">
					Today
				</Link>
				{(
					[
						["Previous", -1, "chevronLeft"],
						["Next", 1, "chevronRight"],
					] as const
				).map(([name, steps, icon]) => {
					// The calendar has no period before 1970 or after 2100: the control has no link there.
					const target = shiftTarget(view, anchor, steps, FIRST_DAY);
					const label = `${name} ${unit}`;
					return target ? (
						<Link
							key={name}
							to={calendarPath(view, target, calendarId)}
							className="icon-button"
							aria-label={label}
							title={label}
						>
							<Icon name={icon} />
						</Link>
					) : (
						<button key={name} type="button" className="icon-button" aria-label={label} aria-disabled="true" disabled>
							<Icon name={icon} />
						</button>
					);
				})}
				<h2 className="cal-period" aria-live="polite">
					{title}
				</h2>
				<span className="toolbar-spacer" />
				<nav className="cal-views" aria-label="Calendar view">
					{(["week", "month"] as const).map((option) => (
						<Link
							key={option}
							to={calendarPath(option, anchor, calendarId)}
							className={option === view ? "button cal-view cal-view-active" : "button cal-view"}
							aria-current={option === view ? "page" : undefined}
						>
							{option === "week" ? "Week" : "Month"}
						</Link>
					))}
				</nav>
			</div>
			{ownerName !== null && !refused && (
				<p className="field-hint cal-delegated">
					You schedule for {ownerName}. You see the time of each event, and the title of an event that is not private.{" "}
					{ownerName} is the organizer of the events that you add.
				</p>
			)}
			{refused && (
				<div className="cal-error" role="alert">
					<span>You cannot use the calendar of {ownerName}. The access ended.</span>
					<Link to={calendarPath(view, anchor)} className="button button-small">
						My calendar
					</Link>
				</div>
			)}
			{state.status === "error" && !refused && (
				<div className="cal-error" role="alert">
					<span>The events did not load. {errorMessage(state.error)}</span>
					<button type="button" className="button button-small" onClick={() => void retry()}>
						Try again
					</button>
				</div>
			)}
			<p className="visually-hidden" role="status">
				{state.status === "loading"
					? "Loading events…"
					: state.status === "ready" && state.events.length === 0
						? `No events this ${unit}.`
						: ""}
			</p>
			<div className="cal-body" aria-busy={state.status === "loading"}>
				{phone ? (
					state.status === "loading" ? (
						<p className="list-state">
							<span className="spinner" aria-hidden="true" />
							Loading…
						</p>
					) : (
						<AgendaList days={agendaDays} events={state.events} zone={zone} today={today} onOpen={openEvent} />
					)
				) : view === "week" ? (
					<WeekView
						days={period.days}
						events={state.events}
						zone={zone}
						today={today}
						onOpen={openEvent}
						onCreate={createAt}
					/>
				) : (
					<MonthView
						days={period.days}
						events={state.events}
						zone={zone}
						today={today}
						month={month}
						calendarId={calendarId}
						onOpen={openEvent}
						onCreate={createAt}
					/>
				)}
			</div>
			{sharing && <CalendarSharing onClose={() => setSharing(false)} />}
			{dialog && (
				<EventDialog
					calendar={calendarId === null ? null : { id: calendarId, name: ownerName ?? calendarId }}
					event={dialog.event}
					initial={dialog.initial}
					zone={zone}
					onChanged={() => void reload()}
					onClose={() => {
						setDialog(null);
						void reload();
					}}
				/>
			)}
		</main>
	);
}
