import { type CalendarEvent, zonedDate } from "@asterra/contracts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "../../lib/router.tsx";
import { calendarPath } from "../../routes.ts";
import {
	DAY_MINUTES,
	type DaySegment,
	eventKey,
	eventLabel,
	eventsByDay,
	HOURS,
	hourText,
	longDate,
	placeSegments,
	timeText,
	wallMinutes,
	weekdayName,
} from "./model.ts";

/** The height of one hour in the grid of the week view, in pixels. */
const HOUR_PX = 48;
const MINUTE_PX = HOUR_PX / 60;
/** The lowest height of an event in the grid, so a short event stays readable and easy to click. */
const MIN_EVENT_PX = 22;
/** The grid opens at this hour. */
const FIRST_VISIBLE_HOUR = 7;
/** An event shorter than this has one line in the grid. */
const SHORT_EVENT_MINUTES = 45;
/** An event shorter than this has no room for its location in the grid. */
const PLACE_MINUTES = 90;
/** The most events that a day of the month view shows. A link to the week shows the others. */
const MONTH_DAY_EVENTS = 3;

interface ViewProps {
	days: readonly string[];
	events: readonly CalendarEvent[];
	zone: string;
	today: string;
	onOpen: (event: CalendarEvent) => void;
	/** Opens the dialog for a new event on a day, at an hour or at 09:00. */
	onCreate: (date: string, hour?: number) => void;
}

function EventButton({
	segment,
	zone,
	onOpen,
	compact,
}: {
	segment: DaySegment;
	zone: string;
	onOpen: (event: CalendarEvent) => void;
	compact?: boolean;
}) {
	const { event } = segment;
	const start = event.when.kind === "timed" ? Date.parse(event.when.start) : null;
	const classes = ["cal-event"];
	if (segment.allDay) classes.push("cal-event-all-day");
	if (event.my_response === "declined") classes.push("cal-event-declined");
	// A short event has one line in the grid: the title, then the time. An event with no room for its place hides it.
	else if (segment.end - segment.start < SHORT_EVENT_MINUTES) classes.push("cal-event-short");
	else if (segment.end - segment.start < PLACE_MINUTES) classes.push("cal-event-brief");
	return (
		<button
			type="button"
			className={classes.join(" ")}
			aria-label={eventLabel(event, zone)}
			title={eventLabel(event, zone)}
			onClick={() => onOpen(event)}
		>
			{!segment.allDay && start !== null && !segment.continued && (
				<span className="cal-event-time">{timeText(start, zone)}</span>
			)}
			<span className="cal-event-title">
				{event.recurrence && (
					<span className="cal-event-repeat" aria-hidden="true">
						↻{" "}
					</span>
				)}
				{event.title}
			</span>
			{!compact && event.location && <span className="cal-event-location">{event.location}</span>}
		</button>
	);
}

/**
 * The minutes of now on the wall clock of the zone, updated each minute. Null when `today` is not the date
 * of now.
 */
function useNowMinutes(today: string, zone: string): number | null {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => window.clearInterval(timer);
	}, []);
	return zonedDate(now, zone) === today ? wallMinutes(now, zone) : null;
}

/** The week view: a row of all-day events, and a grid of hours with the timed events of each day. */
export function WeekView({ days, events, zone, today, onOpen, onCreate }: ViewProps) {
	const byDay = useMemo(() => eventsByDay(events, days, zone), [events, days, zone]);
	const scroller = useRef<HTMLDivElement>(null);
	const nowMinutes = useNowMinutes(today, zone);

	useLayoutEffect(() => {
		// A little less than the hour, so the label of the hour shows under the top rows.
		if (scroller.current) scroller.current.scrollTop = FIRST_VISIBLE_HOUR * HOUR_PX - 8;
	}, []);

	return (
		<div className="cal-week" ref={scroller}>
			{/* The days and the all-day row stay at the top, in the same scroll box as the grid, so the columns line up. */}
			<div className="cal-week-top">
				<div className="cal-week-head" aria-hidden="true">
					<span className="cal-gutter" />
					{days.map((day) => (
						<span key={day} className={day === today ? "cal-day-head cal-today" : "cal-day-head"}>
							<span className="cal-day-name">{weekdayName(day)}</span>
							<span className="cal-day-number">{Number(day.slice(8))}</span>
						</span>
					))}
				</div>
				<div className="cal-all-day-row">
					<span className="cal-gutter cal-gutter-label" aria-hidden="true">
						All day
					</span>
					{days.map((day) => {
						const allDay = (byDay.get(day) ?? []).filter((segment) => segment.allDay);
						return (
							<section key={day} className="cal-all-day-cell" aria-label={`All day, ${longDate(day)}`}>
								{allDay.length > 0 && (
									<ul className="cal-list">
										{allDay.map((segment) => (
											<li key={eventKey(segment.event)}>
												<EventButton segment={segment} zone={zone} onOpen={onOpen} compact />
											</li>
										))}
									</ul>
								)}
							</section>
						);
					})}
				</div>
			</div>
			<div className="cal-week-grid" style={{ height: DAY_MINUTES * MINUTE_PX }}>
				<div className="cal-gutter cal-hours" aria-hidden="true">
					{HOURS.slice(1).map((hour) => (
						<span key={hour} className="cal-hour-label" style={{ top: hour * HOUR_PX }}>
							{hourText(hour)}
						</span>
					))}
				</div>
				{days.map((day) => {
					const placed = placeSegments(byDay.get(day) ?? []);
					return (
						<section
							key={day}
							className={day === today ? "cal-day cal-today" : "cal-day"}
							aria-label={longDate(day)}
							aria-current={day === today ? "date" : undefined}
						>
							{/* A click on a free hour adds an event there. The New event button does the same for a keyboard. */}
							<div className="cal-slots" aria-hidden="true">
								{HOURS.map((hour) => (
									<button
										key={hour}
										type="button"
										tabIndex={-1}
										className="cal-slot"
										onClick={() => onCreate(day, hour)}
									/>
								))}
							</div>
							{placed.length > 0 && (
								<ul className="cal-list">
									{placed.map(({ segment, column, columns }) => (
										<li
											key={eventKey(segment.event)}
											className="cal-timed"
											style={{
												top: segment.start * MINUTE_PX,
												height: Math.max((segment.end - segment.start) * MINUTE_PX, MIN_EVENT_PX),
												left: `${(column / columns) * 100}%`,
												width: `${100 / columns}%`,
											}}
										>
											<EventButton segment={segment} zone={zone} onOpen={onOpen} />
										</li>
									))}
								</ul>
							)}
							{day === today && nowMinutes !== null && (
								<span className="cal-now" style={{ top: nowMinutes * MINUTE_PX }} aria-hidden="true" />
							)}
						</section>
					);
				})}
			</div>
		</div>
	);
}

/** The month view: six weeks, each day with its first events and a link to the week for the others. */
export function MonthView({ days, events, zone, today, month, onOpen, onCreate }: ViewProps & { month: string }) {
	const byDay = useMemo(() => eventsByDay(events, days, zone), [events, days, zone]);
	return (
		<div className="cal-month">
			<div className="cal-month-head" aria-hidden="true">
				{days.slice(0, 7).map((day) => (
					<span key={day}>{weekdayName(day)}</span>
				))}
			</div>
			<div className="cal-month-grid">
				{days.map((day) => {
					const segments = byDay.get(day) ?? [];
					const shown = segments.slice(0, MONTH_DAY_EVENTS);
					const hidden = segments.length - shown.length;
					const classes = ["cal-month-day"];
					if (day.slice(0, 7) !== month) classes.push("cal-other-month");
					if (day === today) classes.push("cal-today");
					return (
						<section
							key={day}
							className={classes.join(" ")}
							aria-label={longDate(day)}
							aria-current={day === today ? "date" : undefined}
						>
							<button
								type="button"
								tabIndex={-1}
								aria-hidden="true"
								className="cal-slot cal-month-slot"
								onClick={() => onCreate(day)}
							/>
							<Link to={calendarPath("week", day)} className="cal-month-number" aria-label={`Week of ${longDate(day)}`}>
								{Number(day.slice(8))}
							</Link>
							{shown.length > 0 && (
								<ul className="cal-list">
									{shown.map((segment) => (
										<li key={eventKey(segment.event)}>
											<EventButton segment={segment} zone={zone} onOpen={onOpen} compact />
										</li>
									))}
								</ul>
							)}
							{hidden > 0 && (
								<Link to={calendarPath("week", day)} className="cal-more">
									{hidden} more
								</Link>
							)}
						</section>
					);
				})}
			</div>
		</div>
	);
}

/** The phone layout: the days of the period that have events, each with its events in order. */
export function AgendaList({ days, events, zone, today, onOpen }: Omit<ViewProps, "onCreate">) {
	const byDay = useMemo(() => eventsByDay(events, days, zone), [events, days, zone]);
	const busy = days.filter((day) => (byDay.get(day) ?? []).length > 0);
	if (busy.length === 0) {
		return <p className="list-state">No events in this period.</p>;
	}
	return (
		<div className="cal-agenda">
			{busy.map((day) => (
				<section
					key={day}
					className={day === today ? "cal-agenda-day cal-today" : "cal-agenda-day"}
					aria-current={day === today ? "date" : undefined}
				>
					<h2 className="cal-agenda-date">{longDate(day)}</h2>
					<ul className="cal-list">
						{(byDay.get(day) ?? []).map((segment) => (
							<li key={eventKey(segment.event)}>
								<EventButton segment={segment} zone={zone} onOpen={onOpen} />
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}
