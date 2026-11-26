import { CALENDAR_LIMITS, type EventAttendee } from "@asterra/contracts";
import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { moveIndex } from "../../lib/listbox.ts";
import { kindTag } from "../../lib/principalKind.ts";
import { usePeopleSearch } from "./data.ts";
import { attendeeKey, type ChosenAttendee, responseLabel, typedAddress } from "./model.ts";

/** An option of the list: a principal of the organization, or a typed address outside it. */
interface Option {
	key: string;
	attendee: ChosenAttendee;
	kind: "human" | "agent" | "service" | null;
}

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
 * organization by name or address, and the list of the chosen attendees with their answers. A typed address that
 * no principal has gives the option to invite that address by mail. The arrow keys move in the suggestions, Enter
 * takes the selected one, and Escape closes the list.
 */
export function AttendeePicker({ chosen, onChange, saved, selfId, disabled }: AttendeePickerProps) {
	const id = useId();
	const [text, setText] = useState("");
	const [active, setActive] = useState(0);
	const [open, setOpen] = useState(false);
	const search = usePeopleSearch(text);
	const chosenKeys = new Set(chosen.map(attendeeKey));
	const answered = search.query === text.trim();
	const people: Option[] = (answered ? search.found : [])
		.filter((entry) => entry.id !== selfId && !chosenKeys.has(entry.id))
		.map((entry) => ({
			key: entry.id,
			attendee: { principal_id: entry.id, name: entry.display_name, email: entry.address, kind: entry.kind },
			kind: entry.kind,
		}));
	// An address that no principal of the list has: the attendee gets the invitation by mail. The server finds a
	// principal of the organization for an address on its domains.
	const address = answered ? typedAddress(text) : null;
	const outside =
		address &&
		!chosenKeys.has(address) &&
		!(search.found ?? []).some((entry) => entry.address.toLowerCase() === address)
			? [{ key: `mail:${address}`, attendee: { principal_id: null, name: address, email: address }, kind: null }]
			: [];
	const options: Option[] = [...people, ...outside];
	const full = chosen.length >= CALENDAR_LIMITS.attendees;
	const shown = open && !disabled && !full && options.length > 0;
	const listId = `${id}-people`;
	const optionId = (index: number) => `${id}-person-${index}`;
	const answers = new Map(saved.map((attendee) => [attendeeKey(attendee), attendee.response]));

	// A new answer selects its first option.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the selection starts again for each new answer of the server.
	useEffect(() => setActive(0), [search]);

	function choose(index: number) {
		const option = options[index];
		if (!option) return;
		onChange([...chosen, option.attendee]);
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
			options.map((option) => ({ label: option.attendee.name })),
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
					<div id={listId} role="listbox" className="cal-people-options" aria-label="People to invite">
						{options.map((option, index) => (
							// The combobox has the focus and the keys. A pointer selects and takes an option.
							// biome-ignore lint/a11y/useKeyWithClickEvents: the keys go to the combobox, as the ARIA combobox pattern asks.
							<div
								key={option.key}
								id={optionId(index)}
								role="option"
								tabIndex={-1}
								aria-selected={index === active}
								className="cal-people-option"
								onMouseDown={(event) => event.preventDefault()}
								onMouseMove={() => index !== active && setActive(index)}
								onClick={() => choose(index)}
							>
								{option.attendee.principal_id ? (
									<>
										<span className="cal-person-name">
											{option.attendee.name}
											{option.kind && kindTag(option.kind) && (
												<span className="cal-person-kind"> · {kindTag(option.kind)}</span>
											)}
										</span>
										<span className="cal-person-address">{option.attendee.email}</span>
									</>
								) : (
									<>
										<span className="cal-person-name">Invite {option.attendee.email} by mail</span>
										<span className="cal-person-address">Outside your organization</span>
									</>
								)}
							</div>
						))}
					</div>
				)}
			</div>
			{chosen.length > 0 && (
				<ul className="cal-list cal-attendee-list" aria-label="Attendees">
					{chosen.map((attendee) => {
						const key = attendeeKey(attendee);
						const response = answers.get(key);
						return (
							<li key={key} className="cal-attendee">
								<span className="cal-person">
									<span className="cal-person-name">{attendee.name}</span>
									<span className="cal-person-address">
										{attendee.principal_id ? attendee.email : "Outside your organization, by mail"}
									</span>
								</span>
								<span className="cal-attendee-response">
									{response ? responseLabel(response) : "Invitation when you save"}
								</span>
								<button
									type="button"
									className="button button-small"
									aria-label={`Remove ${attendee.name}`}
									disabled={disabled}
									onClick={() => onChange(chosen.filter((item) => attendeeKey(item) !== key))}
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
