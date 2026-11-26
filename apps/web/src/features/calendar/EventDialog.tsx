import { ApiError, CALENDAR_LIMITS, type CalendarEvent } from "@asterra/contracts";
import { type FormEvent, useId, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { Icon } from "../../lib/icons.tsx";
import { Select } from "../../lib/Select.tsx";
import { useToast } from "../../lib/toast.tsx";
import { principalOption, usePrincipals } from "../../lib/usePrincipals.ts";
import { useSession } from "../auth/session.tsx";
import { createEvent, deleteEvent, updateEvent } from "./data.ts";
import { FindTime } from "./FindTime.tsx";
import {
	changedSharing,
	type EventForm,
	eventTitle,
	formOf,
	formProblem,
	isInvitation,
	sameTimeFields,
	whenOf,
	withSlot,
} from "./model.ts";

interface EventDialogProps {
	/** The event to change, or null for a new event. */
	event: CalendarEvent | null;
	/** The form of a new event. */
	initial: EventForm;
	zone: string;
	/** Called after a save or a delete, with the event that changed. */
	onChanged: (event: CalendarEvent) => void;
	onClose: () => void;
}

/** The dialog that adds an event, or changes or deletes one. */
export function EventDialog({ event, initial, zone, onChanged, onClose }: EventDialogProps) {
	const toast = useToast();
	// The form that the dialog opened with. A save sends the time, the attendees and the visibility only when
	// the person changed them.
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
	const ids = {
		title: useId(),
		allDay: useId(),
		location: useId(),
		notes: useId(),
		attendee: useId(),
		private: useId(),
	};
	const selfId = useSession().whoami.principal.id;
	const principals = usePrincipals();
	const [finding, setFinding] = useState(false);
	const startTime = useRef<HTMLInputElement>(null);
	// An invitation from a different calendar: only its organizer changes it. The person can remove the copy.
	const invitation = event !== null && isInvitation(event);
	const names = useMemo(
		() => new Map((principals ?? []).map((principal) => [principal.id, principal] as const)),
		[principals],
	);
	const attendeeOptions = useMemo(
		() =>
			(principals ?? [])
				.filter((principal) => principal.id !== selfId && !form.attendees.includes(principal.id))
				.map(principalOption),
		[principals, selfId, form.attendees],
	);

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
					...changedSharing(form, opened),
					...(sameTimeFields(form, opened) ? {} : { when: whenOf(form, zone) }),
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
					attendees: form.attendees,
					visibility: form.visibility,
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
		return (
			<ConfirmDialog
				title={invitation ? "Remove this invitation?" : "Delete this event?"}
				confirmLabel={invitation ? "Remove" : "Delete"}
				danger
				onConfirm={async () => {
					await deleteEvent(event.id, event.revision);
					deleted.current = true;
					toast({ message: "Event deleted." });
					onChanged(event);
				}}
				onClose={() => (deleted.current ? onClose() : setConfirmDelete(false))}
			>
				<p>
					<strong>{eventTitle(event)}</strong> goes away from your calendar.{" "}
					{invitation
						? "The organizer keeps the event."
						: event.attendees.length > 0
							? "Each attendee loses it too. This cannot be undone."
							: "This cannot be undone."}
				</p>
			</ConfirmDialog>
		);
	}

	return (
		<Dialog
			title={invitation ? "Invitation" : event ? "Edit event" : "New event"}
			onClose={() => !busy && onClose()}
			className="cal-dialog"
		>
			<form className="dialog-body cal-form" onSubmit={save} noValidate>
				{invitation && event && (
					<p className="field-hint">
						Organizer: {names.get(event.organizer_id)?.display_name ?? event.organizer_id}. Only the organizer changes
						this event.
					</p>
				)}
				<fieldset className="cal-fields" disabled={invitation}>
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
								ref={startTime}
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
						<label className="field-label" htmlFor={ids.attendee}>
							Attendees
						</label>
						{form.attendees.length > 0 && (
							<ul className="chips cal-attendees" aria-label="Attendees">
								{form.attendees.map((id) => {
									const name = names.get(id)?.display_name ?? id;
									return (
										<li key={id} className="chip cal-attendee">
											{name}
											{!invitation && (
												<button
													type="button"
													className="cal-attendee-remove"
													aria-label={`Remove ${name}`}
													onClick={() =>
														set(
															"attendees",
															form.attendees.filter((attendee) => attendee !== id),
														)
													}
												>
													<Icon name="close" />
												</button>
											)}
										</li>
									);
								})}
							</ul>
						)}
						{!invitation && (
							<Select
								id={ids.attendee}
								value=""
								options={attendeeOptions}
								placeholder={principals === null ? "Loading people…" : "Add a person or an agent"}
								disabled={principals === null || form.attendees.length >= CALENDAR_LIMITS.attendees}
								onChange={(id) => set("attendees", [...form.attendees, id])}
							/>
						)}
						<p className="field-hint">Each attendee gets the event on their calendar, with you as the organizer.</p>
					</div>
					{!invitation && (
						<div className="cal-find-toggle">
							<button
								type="button"
								className="button"
								aria-expanded={finding}
								onClick={() => setFinding((open) => !open)}
							>
								<Icon name="search" />
								Find a time
							</button>
						</div>
					)}
					{finding && !invitation && (
						<FindTime
							attendees={form.attendees}
							principals={principals ?? []}
							selfId={selfId}
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
							onChange={(change) => set("visibility", change.target.checked ? "private" : "default")}
						/>
						Private: a person or an agent that schedules for you sees only the time
					</label>
				</fieldset>
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
							{invitation ? "Remove from my calendar" : "Delete"}
						</button>
					)}
					<span className="toolbar-spacer" />
					<button type="button" className="button" disabled={busy} onClick={onClose}>
						{conflict || invitation ? "Close" : "Cancel"}
					</button>
					{!conflict && !invitation && (
						<button type="submit" className="button button-primary" disabled={busy}>
							{busy ? "Saving…" : "Save"}
						</button>
					)}
				</div>
			</form>
		</Dialog>
	);
}
