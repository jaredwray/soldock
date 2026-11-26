import { ApiError, CALENDAR_LIMITS, type CalendarEvent } from "@asterra/contracts";
import { type FormEvent, useId, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { useToast } from "../../lib/toast.tsx";
import { createEvent, deleteEvent, updateEvent } from "./data.ts";
import { type EventForm, formOf, formProblem, sameTimeFields, whenOf } from "./model.ts";

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
	// The form that the dialog opened with. A save sends the time only when a time field is different.
	const [opened] = useState<EventForm>(() => (event ? formOf(event, zone) : initial));
	const [form, setForm] = useState<EventForm>(opened);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [conflict, setConflict] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	// One key for each form: a second click on Save, or a retry after a lost answer, adds one event.
	const idempotencyKey = useRef(crypto.randomUUID());
	// True after a save that failed. The server refuses the key of that save with a different form.
	const saveFailed = useRef(false);
	// Cancel in the delete question goes back to the form. After the delete, the whole dialog closes.
	const deleted = useRef(false);
	const ids = { title: useId(), allDay: useId(), location: useId(), notes: useId() };

	const set = <K extends keyof EventForm>(key: K, value: EventForm[K]) => {
		// A changed form after a failed save is a new request, so it gets a new key. A retry keeps the key.
		if (saveFailed.current) {
			saveFailed.current = false;
			idempotencyKey.current = crypto.randomUUID();
		}
		setForm((current) => ({ ...current, [key]: value }));
	};

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
					base_revision: event.revision,
				});
				toast({ message: "Event saved." });
				onChanged(saved);
			} else {
				const { event: saved } = await createEvent({
					title,
					when: whenOf(form, zone),
					location: form.location.trim(),
					description: form.description,
					idempotency_key: idempotencyKey.current,
				});
				toast({ message: "Event added." });
				onChanged(saved);
			}
			onClose();
		} catch (caught) {
			saveFailed.current = true;
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
				title="Delete this event?"
				confirmLabel="Delete"
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
					<strong>{event.title}</strong> goes away from your calendar. This cannot be undone.
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
