import { CALENDAR_LIMITS, type EventAttendee } from "@asterra/contracts";
import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { moveIndex } from "../../lib/listbox.ts";
import { kindTag } from "../../lib/principalKind.ts";
import { usePeopleSearch } from "./data.ts";
import { type ChosenAttendee, responseLabel } from "./model.ts";

interface AttendeePickerProps {
	/** The attendees that the organizer chose. */
	chosen: readonly ChosenAttendee[];
	onChange: (chosen: ChosenAttendee[]) => void;
	/** The attendees of the saved event, with their answers. */
	saved: readonly EventAttendee[];
	/** The id of the organizer: the list does not suggest the organizer. */
	selfId: string;
	disabled: boolean;
}

/**
 * The attendee field of the event dialog: a search of the people, agents and service accounts of the
 * organization by name or address, and the list of the chosen attendees with their answers. The arrow keys move
 * in the suggestions, Enter takes the selected one, and Escape closes the list.
 */
export function AttendeePicker({ chosen, onChange, saved, selfId, disabled }: AttendeePickerProps) {
	const id = useId();
	const [text, setText] = useState("");
	const [active, setActive] = useState(0);
	const [open, setOpen] = useState(false);
	const search = usePeopleSearch(text);
	const chosenIds = new Set(chosen.map((attendee) => attendee.principal_id));
	const options = (search.query === text.trim() ? search.found : []).filter(
		(entry) => entry.id !== selfId && !chosenIds.has(entry.id),
	);
	const full = chosen.length >= CALENDAR_LIMITS.attendees;
	const shown = open && !disabled && !full && options.length > 0;
	const listId = `${id}-people`;
	const optionId = (index: number) => `${id}-person-${index}`;
	const answers = new Map(saved.map((attendee) => [attendee.principal_id, attendee.response]));

	// A new answer selects its first option.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the selection starts again for each new answer of the server.
	useEffect(() => setActive(0), [search]);

	function choose(index: number) {
		const entry = options[index];
		if (!entry) return;
		onChange([...chosen, { principal_id: entry.id, name: entry.display_name, email: entry.address, kind: entry.kind }]);
		setText("");
		setOpen(false);
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		// Enter in a text field saves the form. With a typed name and no list yet, that saves the event without the
		// person. So Enter does nothing until the list shows.
		if (!shown && event.key === "Enter" && text.trim() !== "") event.preventDefault();
		if (!shown) return;
		if (event.key === "Enter") {
			event.preventDefault();
			choose(active);
			return;
		}
		if (event.key === "Escape") {
			// Escape closes the list. The dialog stays open.
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
			return;
		}
		const next = moveIndex(
			options.map((entry) => ({ label: entry.display_name })),
			active,
			event.key,
		);
		if (next !== null && next >= 0) {
			event.preventDefault();
			setActive(next);
		}
	}

	return (
		<div className="field cal-attendees">
			<label className="field-label" htmlFor={id}>
				Attendees
			</label>
			<div className="cal-people-field">
				<input
					id={id}
					className="input"
					type="text"
					autoComplete="off"
					spellCheck={false}
					placeholder={full ? `At most ${CALENDAR_LIMITS.attendees} attendees` : "Add people by name or address"}
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={shown}
					aria-controls={shown ? listId : undefined}
					aria-activedescendant={shown ? optionId(active) : undefined}
					value={text}
					disabled={disabled || full}
					onChange={(change) => {
						setText(change.target.value);
						setOpen(true);
					}}
					onKeyDown={onKeyDown}
					onBlur={() => setOpen(false)}
				/>
				{shown && (
					<div id={listId} role="listbox" className="cal-people-options" aria-label="People of the organization">
						{options.map((entry, index) => (
							// The combobox has the focus and the keys. A pointer selects and takes an option.
							// biome-ignore lint/a11y/useKeyWithClickEvents: the keys go to the combobox, as the ARIA combobox pattern asks.
							<div
								key={entry.id}
								id={optionId(index)}
								role="option"
								tabIndex={-1}
								aria-selected={index === active}
								className="cal-people-option"
								onMouseDown={(event) => event.preventDefault()}
								onMouseMove={() => index !== active && setActive(index)}
								onClick={() => choose(index)}
							>
								<span className="cal-person-name">
									{entry.display_name}
									{kindTag(entry.kind) && <span className="cal-person-kind"> · {kindTag(entry.kind)}</span>}
								</span>
								<span className="cal-person-address">{entry.address}</span>
							</div>
						))}
					</div>
				)}
			</div>
			{chosen.length > 0 && (
				<ul className="cal-list cal-attendee-list" aria-label="Attendees">
					{chosen.map((attendee) => {
						const response = answers.get(attendee.principal_id);
						return (
							<li key={attendee.principal_id} className="cal-attendee">
								<span className="cal-person">
									<span className="cal-person-name">{attendee.name}</span>
									<span className="cal-person-address">{attendee.email}</span>
								</span>
								<span className="cal-attendee-response">
									{response ? responseLabel(response) : "Invitation when you save"}
								</span>
								<button
									type="button"
									className="button button-small"
									aria-label={`Remove ${attendee.name}`}
									disabled={disabled}
									onClick={() => onChange(chosen.filter((item) => item.principal_id !== attendee.principal_id))}
								>
									Remove
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
