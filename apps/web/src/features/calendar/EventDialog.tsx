import { ApiError, CALENDAR_LIMITS, type CalendarEvent, type EventResponse } from "@asterra/contracts";
import { type FormEvent, useId, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { Select } from "../../lib/Select.tsx";
import { useToast } from "../../lib/toast.tsx";
import { principalOption, usePrincipals } from "../../lib/usePrincipals.ts";
import { useSession } from "../auth/session.tsx";
import {
	cancelOccurrence,
	createEvent,
	deleteEvent,
	getEvent,
	respondToEvent,
	setReminder,
	updateEvent,
	updateOccurrence,
} from "./data.ts";
import { FindTime } from "./FindTime.tsx";
import {
	type EventForm,
	eventTitle,
	formOf,
	formProblem,
	REMINDER_OPTIONS,
	REPEAT_OPTIONS,
	type ReminderChoice,
	type RepeatChoice,
	recurrenceOf,
	reminderOf,
	repeatChoice,
	repeatText,
	sameRepeat,
	sameTimeFields,
	seriesWhen,
	whenOf,
	whenText,
	withSlot,
	zoneOfEvent,
} from "./model.ts";

interface EventDialogProps {
	/** The event or the occurrence to change, or null for a new event. */
	event: CalendarEvent | null;
	/** The form of a new event. */
	initial: EventForm;
	zone: string;
	/** Called after a save or a delete, with the event that changed. */
	onChanged: (event: CalendarEvent) => void;
	onClose: () => void;
	/** The calendar of a person who lets the person schedule, or null for the own calendar. */
	calendar?: { id: string; name: string } | null;
}

/** An action on one occurrence of a series that asks first: this occurrence, or the entire series. */
type ScopedAction = "save" | "delete" | "accepted" | "declined";
type Scope = "this" | "all";

const RESPONSE_TEXT: Record<EventResponse, string> = {
	needs_action: "You did not respond yet.",
	accepted: "You accepted.",
	declined: "You declined.",
};

/** The dialog that adds an event, or changes or deletes one. For an invitation, it sets the response. */
export function EventDialog({ event, initial, zone, onChanged, onClose, calendar = null }: EventDialogProps) {
	const toast = useToast();
	const ownId = useSession().whoami.principal.id;
	// In the calendar of a different person, that person is the organizer: the attendees leave out that person.
	const organizerId = calendar?.id ?? ownId;
	const calendarId = calendar?.id ?? null;
	const on = calendarId === null ? {} : { calendar_id: calendarId };
	// The form that the dialog opened with. A save sends a field only when it is different.
	const [opened] = useState<EventForm>(() => (event ? formOf(event, zone) : initial));
	const [form, setForm] = useState<EventForm>(opened);
	const openedAttendees = useMemo(() => (event?.attendees ?? []).map((a) => a.principal_id), [event]);
	const [attendees, setAttendees] = useState<string[]>(openedAttendees);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [conflict, setConflict] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [scoped, setScoped] = useState<ScopedAction | null>(null);
	const [scope, setScope] = useState<Scope>("this");
	// One key for each request of the dialog. A second click on Save, or a retry after a lost answer, sends the
	// same request with the same key, so the server adds one event. A different request gets its own key.
	const keys = useRef(new Map<string, string>());
	// Cancel in a question goes back to the form. After the action, the whole dialog closes.
	const done = useRef(false);
	const ids = {
		title: useId(),
		allDay: useId(),
		location: useId(),
		notes: useId(),
		repeat: useId(),
		reminder: useId(),
		people: useId(),
		private: useId(),
	};
	const [finding, setFinding] = useState(false);
	const startTime = useRef<HTMLInputElement>(null);

	// A timed event keeps its own time zone. The person can be in a different zone.
	const eventZone = zoneOfEvent(event, zone);
	const invitation = event?.role === "attendee";
	const occurrence = event?.occurrence_id ?? null;
	// A rule that the dialog cannot show, such as every 3 weeks, keeps its text and cannot change here.
	const customRule = event?.recurrence && repeatChoice(event.recurrence) === null ? event.recurrence : null;
	const principals = usePrincipals();
	const people = useMemo(
		() =>
			(principals ?? []).filter(
				(principal) => principal.kind === "human" && principal.id !== organizerId && !attendees.includes(principal.id),
			),
		[principals, organizerId, attendees],
	);
	const nameOf = (id: string) =>
		event?.attendees.find((a) => a.principal_id === id)?.display_name ??
		principals?.find((principal) => principal.id === id)?.display_name ??
		id;

	// The All day box is locked for an occurrence, so an all-day occurrence cannot take a timed slot.
	const allDayLocked = occurrence !== null && form.allDay;

	const set = <K extends keyof EventForm>(key: K, value: EventForm[K]) =>
		setForm((current) => ({ ...current, [key]: value }));

	const sameAttendees =
		attendees.length === openedAttendees.length && attendees.every((id) => openedAttendees.includes(id));
	const contentChanged =
		form.title.trim() !== opened.title.trim() ||
		form.location.trim() !== opened.location.trim() ||
		form.description !== opened.description ||
		!sameTimeFields(form, opened);
	const sameVisibility = form.visibility === opened.visibility;
	// A change of the rule, of the attendees or of the visibility is a change of the entire series.
	const seriesOnly = !sameRepeat(form, opened) || !sameAttendees || !sameVisibility;

	function fail(caught: unknown) {
		setBusy(false);
		if (caught instanceof ApiError && caught.code === "conflict" && event) {
			setConflict(true);
			setError("The event changed in a different place. Close this dialog to see the new version, then try again.");
			return;
		}
		setError(errorMessage(caught));
	}

	async function saveReminder() {
		// The reminder belongs to the owner of the calendar: a delegate does not change it.
		if (calendarId !== null) return;
		if (event && form.reminder !== opened.reminder) await setReminder(event.id, reminderOf(form));
	}

	/** Saves the changes of the form, for this occurrence or for the entire event. */
	async function commit(target: Scope) {
		if (!event) return;
		await saveReminder();
		if (target === "this" && occurrence) {
			if (!contentChanged) return;
			const { event: saved } = await updateOccurrence({
				...on,
				occurrence_id: occurrence,
				title: form.title.trim(),
				location: form.location.trim(),
				description: form.description,
				...(sameTimeFields(form, opened) ? {} : { when: whenOf(form, zone, eventZone) }),
				base_revision: event.revision,
			});
			onChanged(saved);
			return;
		}
		if (!contentChanged && !seriesOnly) return;
		const timeChanged = !sameTimeFields(form, opened);
		// From an occurrence, the change of the time applies to the first occurrence of the series.
		const seriesTime = async () =>
			occurrence
				? seriesWhen((await getEvent(event.id, calendarId)).event, opened, form, zone)
				: whenOf(form, zone, eventZone);
		// The form of a changed occurrence has the values of that occurrence. A save for the entire series sends
		// only the fields that the person changed, so those values do not go into the series.
		const { event: saved } = await updateEvent({
			...on,
			event_id: event.id,
			...(form.title.trim() === opened.title.trim() ? {} : { title: form.title.trim() }),
			...(form.location.trim() === opened.location.trim() ? {} : { location: form.location.trim() }),
			...(form.description === opened.description ? {} : { description: form.description }),
			...(timeChanged ? { when: await seriesTime() } : {}),
			...(customRule || sameRepeat(form, opened) ? {} : { recurrence: recurrenceOf(form) }),
			...(sameAttendees ? {} : { attendee_ids: attendees }),
			...(sameVisibility ? {} : { visibility: form.visibility }),
			// The revision that the dialog opened with: a change from a different place gives a conflict.
			base_revision: event.revision,
		});
		onChanged(saved);
	}

	async function save(submitted: FormEvent) {
		submitted.preventDefault();
		if (invitation && event) {
			setBusy(true);
			try {
				await saveReminder();
				onChanged(event);
				onClose();
			} catch (caught) {
				fail(caught);
			}
			return;
		}
		const title = form.title.trim();
		if (!title) {
			setError("Give the event a title.");
			return;
		}
		const problem = formProblem(form, zone, {
			eventZone,
			ruleStays: occurrence !== null && sameRepeat(form, opened),
		});
		if (problem) {
			setError(problem);
			return;
		}
		if (event && occurrence && contentChanged && !seriesOnly) {
			setScope("this");
			setScoped("save");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			if (event) {
				await commit("all");
				toast({ message: "Event saved." });
			} else {
				const recurrence = recurrenceOf(form);
				const request = {
					title,
					when: whenOf(form, zone),
					location: form.location.trim(),
					description: form.description,
					...(recurrence ? { recurrence } : {}),
					...(attendees.length > 0 ? { attendee_ids: attendees } : {}),
					// A delegate sends no reminder: the server gives the owner the default one.
					...(form.allDay || calendarId !== null ? {} : { reminder_minutes: reminderOf(form) }),
					visibility: form.visibility,
					...on,
				};
				const text = JSON.stringify(request);
				const key = keys.current.get(text) ?? crypto.randomUUID();
				keys.current.set(text, key);
				const { event: saved } = await createEvent({ ...request, idempotency_key: key });
				toast({ message: "Event added." });
				onChanged(saved);
			}
			onClose();
		} catch (caught) {
			fail(caught);
		}
	}

	async function respond(response: "accepted" | "declined", target: Scope) {
		if (!event) return;
		const { event: saved } = await respondToEvent({
			event_id: event.id,
			...(target === "this" && occurrence ? { occurrence_id: occurrence } : {}),
			response,
		});
		toast({ message: response === "accepted" ? "You accepted the event." : "You declined the event." });
		onChanged(saved);
	}

	async function runScoped(action: ScopedAction, target: Scope) {
		if (!event) return;
		if (action === "save") {
			await commit(target);
			toast({ message: "Event saved." });
		} else if (action === "delete") {
			if (target === "this" && occurrence) await cancelOccurrence(occurrence, event.revision, calendarId);
			else await deleteEvent(event.id, event.revision, calendarId);
			toast({ message: target === "this" ? "Event cancelled." : "Event deleted." });
			onChanged(event);
		} else {
			await respond(action, target);
		}
		done.current = true;
	}

	if (scoped && event) {
		const verb = { save: "Change", delete: "Delete", accepted: "Accept", declined: "Decline" }[scoped];
		return (
			<ConfirmDialog
				title={`${verb} a repeated event`}
				confirmLabel={verb}
				danger={scoped === "delete"}
				onConfirm={() => runScoped(scoped, scope)}
				onClose={() => (done.current ? onClose() : setScoped(null))}
			>
				<fieldset className="cal-scope">
					<legend className="visually-hidden">Which events</legend>
					<label className="check-row">
						<input type="radio" name="scope" checked={scope === "this"} onChange={() => setScope("this")} />
						This event
					</label>
					<label className="check-row">
						<input type="radio" name="scope" checked={scope === "all"} onChange={() => setScope("all")} />
						All events
					</label>
				</fieldset>
			</ConfirmDialog>
		);
	}

	if (confirmDelete && event) {
		return (
			<ConfirmDialog
				title="Delete this event?"
				confirmLabel="Delete"
				danger
				onConfirm={async () => {
					await deleteEvent(event.id, event.revision, calendarId);
					done.current = true;
					toast({ message: "Event deleted." });
					onChanged(event);
				}}
				onClose={() => (done.current ? onClose() : setConfirmDelete(false))}
			>
				<p>
					<strong>{event.title}</strong> goes away from your calendar
					{event.attendees.length > 0 ? " and from the calendar of each attendee" : ""}. This cannot be undone.
				</p>
			</ConfirmDialog>
		);
	}

	const reminderField = !form.allDay && calendarId === null && (
		<div className="field">
			<label className="field-label" htmlFor={ids.reminder}>
				Reminder
			</label>
			<Select<ReminderChoice>
				value={form.reminder}
				options={REMINDER_OPTIONS.map((option) => ({ ...option }))}
				onChange={(value) => set("reminder", value)}
				id={ids.reminder}
				disabled={busy}
			/>
		</div>
	);

	// An event of the owner that a delegate sees only in part: the time, and the title when it is not private.
	if (event?.redacted) {
		return (
			<Dialog title={eventTitle(event)} onClose={onClose} className="cal-dialog">
				<div className="dialog-body cal-form">
					<p>{whenText(event, zone)}</p>
					<p className="field-hint">
						{event.title
							? `You see only the time and the title of this event of ${calendar?.name ?? "the owner"}.`
							: `You see only the time of this event of ${calendar?.name ?? "the owner"}.`}
					</p>
					<div className="dialog-actions">
						<span className="toolbar-spacer" />
						<button type="button" className="button" onClick={onClose}>
							Close
						</button>
					</div>
				</div>
			</Dialog>
		);
	}

	if (invitation && event) {
		const respondTo = (response: "accepted" | "declined") => {
			if (occurrence) {
				setScope("this");
				setScoped(response);
				return;
			}
			setBusy(true);
			respond(response, "all").then(onClose, fail);
		};
		return (
			<Dialog title="Invitation" onClose={() => !busy && onClose()} className="cal-dialog">
				<form className="dialog-body cal-form" onSubmit={save} noValidate>
					<h3 className="cal-invite-title">{event.title}</h3>
					<p className="field-hint">
						From {event.organizer?.display_name ?? "the organizer"}
						{event.recurrence ? `. ${repeatText(event.recurrence)}` : ""}.
					</p>
					{event.location && <p>{event.location}</p>}
					{event.description && <p className="cal-invite-notes">{event.description}</p>}
					<div className="cal-rsvp">
						<span role="status">{RESPONSE_TEXT[event.my_response ?? "needs_action"]}</span>
						<button
							type="button"
							className="button"
							disabled={busy}
							aria-pressed={event.my_response === "accepted"}
							onClick={() => respondTo("accepted")}
						>
							Accept
						</button>
						<button
							type="button"
							className="button"
							disabled={busy}
							aria-pressed={event.my_response === "declined"}
							onClick={() => respondTo("declined")}
						>
							Decline
						</button>
					</div>
					{reminderField}
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
					<div className="dialog-actions cal-actions">
						<span className="toolbar-spacer" />
						<button type="button" className="button" disabled={busy} onClick={onClose}>
							Close
						</button>
						<button type="submit" className="button button-primary" disabled={busy}>
							{busy ? "Saving…" : "Save"}
						</button>
					</div>
				</form>
			</Dialog>
		);
	}

	return (
		<Dialog title={event ? "Edit event" : "New event"} onClose={() => !busy && onClose()} className="cal-dialog">
			<form className="dialog-body cal-form" onSubmit={save} noValidate>
				{calendar && (
					<p className="field-hint">
						In the calendar of {calendar.name}. {calendar.name} is the organizer.
					</p>
				)}
				<div className="field">
					<label className="field-label" htmlFor={ids.title}>
						Title
					</label>
					<input
						id={ids.title}
						className="input"
						value={form.title}
						maxLength={CALENDAR_LIMITS.titleChars}
						onChange={(change) => set("title", change.target.value)}
						required
						data-autofocus
					/>
				</div>
				<label className="check-row" htmlFor={ids.allDay}>
					<input
						id={ids.allDay}
						type="checkbox"
						checked={form.allDay}
						disabled={occurrence !== null}
						onChange={(change) => set("allDay", change.target.checked)}
					/>
					All day
				</label>
				<fieldset className="cal-when">
					<legend className="field-label">Starts</legend>
					<input
						className="input"
						type="date"
						aria-label="Start date"
						value={form.startDate}
						onChange={(change) => set("startDate", change.target.value)}
					/>
					{!form.allDay && (
						<input
							className="input"
							type="time"
							aria-label="Start time"
							ref={startTime}
							value={form.startTime}
							onChange={(change) => set("startTime", change.target.value)}
						/>
					)}
				</fieldset>
				<fieldset className="cal-when">
					<legend className="field-label">{form.allDay ? "Last day" : "Ends"}</legend>
					<input
						className="input"
						type="date"
						aria-label={form.allDay ? "Last day" : "End date"}
						value={form.endDate}
						onChange={(change) => set("endDate", change.target.value)}
					/>
					{!form.allDay && (
						<input
							className="input"
							type="time"
							aria-label="End time"
							value={form.endTime}
							onChange={(change) => set("endTime", change.target.value)}
						/>
					)}
				</fieldset>
				{!form.allDay && <p className="field-hint cal-zone">Times are in {zone}.</p>}
				{customRule ? (
					<p className="field-hint">{repeatText(customRule)}. Use the API to change this repeat.</p>
				) : (
					<div className="field">
						<label className="field-label" htmlFor={ids.repeat}>
							Repeats
						</label>
						<Select<RepeatChoice>
							value={form.repeat}
							options={REPEAT_OPTIONS.map((option) => ({ ...option }))}
							onChange={(value) => set("repeat", value)}
							id={ids.repeat}
							disabled={busy}
						/>
					</div>
				)}
				{!customRule && form.repeat !== "none" && (
					<fieldset className="cal-repeat-ends">
						<legend className="field-label">Ends</legend>
						<label className="check-row">
							<input type="radio" name="ends" checked={form.ends === "never"} onChange={() => set("ends", "never")} />
							Never
						</label>
						<label className="check-row">
							<input type="radio" name="ends" checked={form.ends === "until"} onChange={() => set("ends", "until")} />
							On
						</label>
						<input
							className="input"
							type="date"
							aria-label="Last day of the repeat"
							value={form.until}
							disabled={form.ends !== "until"}
							onChange={(change) => set("until", change.target.value)}
						/>
						<label className="check-row">
							<input type="radio" name="ends" checked={form.ends === "count"} onChange={() => set("ends", "count")} />
							After
						</label>
						<input
							className="input cal-count"
							type="number"
							min={1}
							max={CALENDAR_LIMITS.recurrenceCount}
							aria-label="Number of times"
							value={form.count}
							disabled={form.ends !== "count"}
							onChange={(change) => set("count", change.target.value)}
						/>
						<span>times</span>
					</fieldset>
				)}
				{reminderField}
				<div className="field">
					<label className="field-label" htmlFor={ids.people}>
						Attendees
					</label>
					{attendees.length > 0 && (
						<ul className="cal-people" aria-label="Attendees">
							{attendees.map((id) => {
								const response = event?.attendees.find((a) => a.principal_id === id)?.response;
								return (
									<li key={id} className="chip cal-person">
										{nameOf(id)}
										{response && response !== "needs_action" ? ` (${response})` : ""}
										<button
											type="button"
											className="icon-button"
											aria-label={`Remove ${nameOf(id)}`}
											disabled={busy}
											onClick={() => setAttendees((current) => current.filter((other) => other !== id))}
										>
											×
										</button>
									</li>
								);
							})}
						</ul>
					)}
					<Select<string>
						value=""
						options={people.map(principalOption)}
						placeholder={principals === null ? "Loading…" : "Add a person…"}
						onChange={(value) => value && setAttendees((current) => [...new Set([...current, value])])}
						id={ids.people}
						disabled={busy || principals === null}
					/>
				</div>
				{/* A suggestion is a timed slot. An occurrence of an all-day series cannot become timed. */}
				{!allDayLocked && (
					<div className="cal-find-toggle">
						<button
							type="button"
							className="button"
							aria-expanded={finding}
							onClick={() => setFinding((open) => !open)}
						>
							Find a time
						</button>
					</div>
				)}
				{finding && !allDayLocked && (
					<FindTime
						attendees={attendees}
						principals={principals ?? []}
						selfId={ownId}
						calendarId={calendarId}
						startDate={form.startDate}
						zone={zone}
						onPick={(start, end) => {
							setForm((current) => withSlot(current, start, end, zone));
							setFinding(false);
							// The fields of the time hold the suggestion now. The focus goes there.
							requestAnimationFrame(() => startTime.current?.focus());
						}}
					/>
				)}
				<div className="field">
					<label className="field-label" htmlFor={ids.location}>
						Location
					</label>
					<input
						id={ids.location}
						className="input"
						value={form.location}
						maxLength={CALENDAR_LIMITS.locationChars}
						onChange={(change) => set("location", change.target.value)}
					/>
				</div>
				<div className="field">
					<label className="field-label" htmlFor={ids.notes}>
						Description
					</label>
					<textarea
						id={ids.notes}
						className="input cal-notes"
						rows={4}
						value={form.description}
						maxLength={CALENDAR_LIMITS.descriptionChars}
						onChange={(change) => set("description", change.target.value)}
					/>
				</div>
				<label className="check-row" htmlFor={ids.private}>
					<input
						id={ids.private}
						type="checkbox"
						checked={form.visibility === "private"}
						disabled={busy}
						onChange={(change) => set("visibility", change.target.checked ? "private" : "default")}
					/>
					{calendar
						? `Private: other people and agents that schedule for ${calendar.name} see only the time`
						: "Private: a person or an agent that schedules for you sees only the time"}
				</label>
				{event?.created_by && <p className="field-hint">Added by {nameOf(event.created_by)}</p>}
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				<div className="dialog-actions cal-actions">
					{event && (
						<button
							type="button"
							className="button button-danger-outline"
							disabled={busy}
							onClick={() => {
								if (occurrence) {
									setScope("this");
									setScoped("delete");
								} else {
									setConfirmDelete(true);
								}
							}}
						>
							Delete
						</button>
					)}
					<span className="toolbar-spacer" />
					<button type="button" className="button" disabled={busy} onClick={onClose}>
						{conflict ? "Close" : "Cancel"}
					</button>
					{!conflict && (
						<button type="submit" className="button button-primary" disabled={busy}>
							{busy ? "Saving…" : "Save"}
						</button>
					)}
				</div>
			</form>
		</Dialog>
	);
}
