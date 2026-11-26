import { ApiError, CALENDAR_LIMITS, type CalendarEvent, type EventAnswer } from "@asterra/contracts";
import { type FormEvent, useId, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useSession } from "../auth/session.tsx";
import { AttendeePicker } from "./AttendeePicker.tsx";
import { createEvent, deleteEvent, respondToInvitation, updateEvent } from "./data.ts";
import {
	attendeeInputs,
	type ChosenAttendee,
	chosenOf,
	type EventForm,
	formOf,
	formProblem,
	responseLabel,
	sameAttendees,
	sameTimeFields,
	whenOf,
	whenText,
} from "./model.ts";

interface EventDialogProps {
	/** The event to change, or null for a new event. */
	event: CalendarEvent | null;
	/** True when the calendar does not have the open copy of a meeting now. */
	gone?: boolean;
	/** The form of a new event. */
	initial: EventForm;
	zone: string;
	/** Called after a save or a delete, with the event that changed. */
	onChanged: (event: CalendarEvent) => void;
	onClose: () => void;
}

/** The dialog that adds an event, or changes or deletes one. The copy of a meeting opens the invitation view. */
export function EventDialog(props: EventDialogProps) {
	if (props.event && !props.event.is_organizer) {
		return (
			<InvitationDialog
				event={props.event}
				zone={props.zone}
				gone={props.gone === true}
				onChanged={props.onChanged}
				onClose={props.onClose}
			/>
		);
	}
	return <OrganizerDialog {...props} />;
}

function OrganizerDialog({ event, initial, zone, onChanged, onClose }: EventDialogProps) {
	const toast = useToast();
	const { whoami } = useSession();
	const [openedAttendees] = useState<ChosenAttendee[]>(() => chosenOf(event));
	const [attendees, setAttendees] = useState<ChosenAttendee[]>(openedAttendees);
	// The form that the dialog opened with. A save sends the time only when a time field is different.
	const [opened] = useState<EventForm>(() => (event ? formOf(event, zone) : initial));
	const [form, setForm] = useState<EventForm>(opened);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [conflict, setConflict] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	// One key for each request of the dialog. A second click on Save, or a retry after a lost answer, sends the
	// same request with the same key, so the server adds one event. A different request gets its own key.
	const keys = useRef(new Map<string, string>());
	// Cancel in the delete question goes back to the form. After the delete, the whole dialog closes.
	const deleted = useRef(false);
	const ids = { title: useId(), allDay: useId(), location: useId(), notes: useId() };

	const set = <K extends keyof EventForm>(key: K, value: EventForm[K]) =>
		setForm((current) => ({ ...current, [key]: value }));

	async function save(submitted: FormEvent) {
		submitted.preventDefault();
		const title = form.title.trim();
		if (!title) {
			setError("Give the event a title.");
			return;
		}
		const problem = formProblem(form, zone);
		if (problem) {
			setError(problem);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			if (event) {
				const { event: saved } = await updateEvent({
					event_id: event.id,
					title,
					location: form.location.trim(),
					description: form.description,
					...(sameTimeFields(form, opened) ? {} : { when: whenOf(form, zone) }),
					...(sameAttendees(attendees, openedAttendees) ? {} : { attendees: attendeeInputs(attendees) }),
					base_revision: event.revision,
				});
				toast({ message: "Event saved." });
				onChanged(saved);
			} else {
				const request = {
					title,
					when: whenOf(form, zone),
					location: form.location.trim(),
					description: form.description,
					...(attendees.length > 0 ? { attendees: attendeeInputs(attendees) } : {}),
				};
				const text = JSON.stringify(request);
				const key = keys.current.get(text) ?? crypto.randomUUID();
				keys.current.set(text, key);
				const { event: saved } = await createEvent({ ...request, idempotency_key: key });
				toast({ message: attendees.length > 0 ? "Invitations sent." : "Event added." });
				onChanged(saved);
			}
			onClose();
		} catch (caught) {
			setBusy(false);
			if (caught instanceof ApiError && caught.code === "conflict" && event) {
				setConflict(true);
				setError("The event changed in a different place. Close this dialog to see the new version, then try again.");
				return;
			}
			setError(errorMessage(caught));
		}
	}

	if (confirmDelete && event) {
		const meeting = event.attendees.length > 0;
		return (
			<ConfirmDialog
				title={meeting ? "Cancel this meeting?" : "Delete this event?"}
				confirmLabel={meeting ? "Cancel meeting" : "Delete"}
				{...(meeting ? { cancelLabel: "Keep meeting" } : {})}
				danger
				onConfirm={async () => {
					await deleteEvent(event.id, event.revision);
					deleted.current = true;
					toast({ message: meeting ? "Meeting cancelled." : "Event deleted." });
					onChanged(event);
				}}
				onClose={() => (deleted.current ? onClose() : setConfirmDelete(false))}
			>
				<p>
					{meeting ? (
						<>
							<strong>{event.title}</strong> goes away from your calendar and from the calendar of each attendee. This
							cannot be undone.
						</>
					) : (
						<>
							<strong>{event.title}</strong> goes away from your calendar. This cannot be undone.
						</>
					)}
				</p>
			</ConfirmDialog>
		);
	}

	return (
		<Dialog title={event ? "Edit event" : "New event"} onClose={() => !busy && onClose()} className="cal-dialog">
			<form className="dialog-body cal-form" onSubmit={save} noValidate>
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
				<AttendeePicker
					chosen={attendees}
					onChange={setAttendees}
					saved={event?.attendees ?? []}
					selfId={whoami.principal.id}
					disabled={busy}
				/>
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
							onClick={() => setConfirmDelete(true)}
						>
							{event.attendees.length > 0 ? "Cancel meeting" : "Delete"}
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

const GONE_TEXT = "The organizer cancelled this meeting or removed you from it.";

const ANSWERS: { response: EventAnswer; label: string }[] = [
	{ response: "accepted", label: "Yes" },
	{ response: "tentative", label: "Maybe" },
	{ response: "declined", label: "No" },
];

/**
 * The copy of a meeting that a different principal organizes. The fields are read-only: only the organizer
 * changes them. The attendee answers Yes, Maybe or No.
 */
function InvitationDialog({
	event,
	zone,
	gone: goneNow,
	onChanged,
	onClose,
}: {
	event: CalendarEvent;
	zone: string;
	/** True when a load of the calendar does not have the copy now. */
	gone: boolean;
	onChanged: (event: CalendarEvent) => void;
	onClose: () => void;
}) {
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [refused, setRefused] = useState(false);
	const gone = refused || goneNow;
	const pending = event.my_response === "pending";

	async function answer(response: EventAnswer) {
		setBusy(true);
		setError(null);
		try {
			const { event: saved } = await respondToInvitation(event.id, response);
			toast({ message: "Answer sent." });
			onChanged(saved);
			onClose();
		} catch (caught) {
			setBusy(false);
			if (caught instanceof ApiError && caught.code === "not_found") {
				setRefused(true);
				return;
			}
			setError(errorMessage(caught));
		}
	}

	return (
		<Dialog title={pending ? "Invitation" : "Meeting"} onClose={() => !busy && onClose()} className="cal-dialog">
			<div className="dialog-body cal-form cal-invitation">
				<h3 className="cal-invitation-title">{event.title}</h3>
				<p className="cal-invitation-when">{whenText(event, zone)}</p>
				{event.location && <p className="cal-invitation-location">{event.location}</p>}
				{event.organizer && (
					<p className="cal-invitation-organizer">
						Organizer: {event.organizer.name} ({event.organizer.email})
					</p>
				)}
				{event.description && <p className="cal-invitation-description">{event.description}</p>}
				<ul className="cal-list cal-attendee-list" aria-label="Attendees">
					{event.attendees.map((attendee) => (
						<li key={attendee.email} className="cal-attendee">
							<span className="cal-person">
								<span className="cal-person-name">
									{attendee.name}
									{attendee.self && " (you)"}
								</span>
								<span className="cal-person-address">{attendee.email}</span>
							</span>
							<span className="cal-attendee-response">{responseLabel(attendee.response)}</span>
						</li>
					))}
				</ul>
				{(gone || error) && (
					<p className="form-error" role="alert">
						{gone ? GONE_TEXT : error}
					</p>
				)}
				<div className="dialog-actions cal-actions">
					{!gone && (
						<fieldset className="cal-answer" aria-label="Your answer">
							<span className="field-label">Going?</span>
							{ANSWERS.map(({ response, label }) => (
								<button
									key={response}
									type="button"
									className={`button${event.my_response === response ? " cal-view-active" : ""}`}
									aria-pressed={event.my_response === response}
									disabled={busy}
									onClick={() => void answer(response)}
								>
									{label}
								</button>
							))}
						</fieldset>
					)}
					<span className="toolbar-spacer" />
					<button type="button" className="button" disabled={busy} onClick={onClose} data-autofocus>
						Close
					</button>
				</div>
			</div>
		</Dialog>
	);
}
