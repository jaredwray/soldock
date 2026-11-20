import {
	type ChatWebhookFilter,
	defaultChatWebhookFilter,
	type WebhookDomain,
	type WebhookEvent,
} from "@asterra/contracts";
import { useId, useState } from "react";
import { Select } from "../../lib/Select.tsx";
import {
	CHAT_FILTER_LABELS,
	choiceKey,
	chosenFilter,
	DOMAIN_LABELS,
	EVENT_LABELS,
	eventsFor,
	eventsOf,
	filterForChoice,
	withChatFilter,
} from "./webhookModel.ts";

/** A mailbox, a person, an agent or a drive whose events a webhook can send. */
export interface PickerTarget {
	id: string;
	name: string;
	/** Muted text after the name in the menu, for example the address of a mailbox. */
	description?: string;
	/** True for an agent. A new chat event of an agent starts with only the messages for it, as on the server. */
	agent?: boolean;
}

/** One product and the targets that the person can select for it. */
export interface PickerGroup {
	domain: WebhookDomain;
	targets: readonly PickerTarget[];
}

interface EventPickerProps {
	groups: readonly PickerGroup[];
	/** The keys of the set check boxes. See `choiceKey`. */
	selected: ReadonlySet<string>;
	onChange: (selected: Set<string>) => void;
	/** False when the person can clear a check box but cannot set one. */
	canAdd: boolean;
	/** The events that the webhook sends now. Without `canAdd`, only their check boxes can change. */
	saved: ReadonlySet<string>;
	/** The saved events that stopped, for example after their creator lost access to the target. */
	stopped?: ReadonlySet<string>;
	disabled: boolean;
	/** The id of a text that describes each group, for example why some check boxes are off. */
	describedBy?: string | undefined;
	/** The first check box gets the focus when a `Dialog` opens. */
	autofocus?: boolean;
}

const DOMAIN_HINT: Record<WebhookDomain, string> = {
	mail: "The POST has no mail content. The receiver reads the inbox with its own key.",
	chat: "The POST has no message text. It has the reason, for example a mention.",
	drive: "The POST has no file content. A star sends nothing.",
};

const FILTER_OPTIONS = (["all", "addressed"] as const).map((value) => ({ value, label: CHAT_FILTER_LABELS[value] }));

/**
 * The check boxes of a webhook: one for each event of each product. A product with more than one
 * target has a menu. The check boxes show the events of the target in the menu. Chat has one more
 * menu: the messages that the chat events of the target send.
 */
export function EventPicker({ groups, autofocus, ...rest }: EventPickerProps) {
	return (
		<div className="event-groups">
			{groups.map((group, index) => (
				<EventGroup key={group.domain} group={group} autofocus={autofocus === true && index === 0} {...rest} />
			))}
		</div>
	);
}

function EventGroup({
	group,
	selected,
	onChange,
	canAdd,
	saved,
	stopped,
	disabled,
	describedBy,
	autofocus,
}: Omit<EventPickerProps, "groups"> & { group: PickerGroup }) {
	const { domain, targets } = group;
	const targetId = useId();
	const hintId = useId();
	const filterId = useId();
	// The filter that the person chose for a target, for the time when the target has no chat event set.
	const [filterChoice, setFilterChoice] = useState<Record<string, ChatWebhookFilter>>({});
	const count = (id: string) => eventsOf(domain).filter((event) => chosenFilter(selected, event, id) !== null).length;
	// The menu starts at the first target that has an event, so an edit shows the current events.
	const [shown, setShown] = useState(() => (targets.find((target) => count(target.id) > 0) ?? targets[0])?.id ?? "");
	const target = targets.find((candidate) => candidate.id === shown) ?? targets[0];
	if (!target) return null;

	// A target offers the events that it can send. A saved event of a different kind stays, so the person can clear it.
	const offered = eventsFor(domain, target.id);
	const events = eventsOf(domain).filter(
		(event) => offered.includes(event) || chosenFilter(saved, event, target.id) !== null,
	);
	const all = offered.length > 1 && canAdd;
	const locked = (event: WebhookEvent) => disabled || (!canAdd && chosenFilter(saved, event, target.id) === null);
	// The check box for all events sets only the events that the target can send.
	const set = offered.filter((event) => chosenFilter(selected, event, target.id) !== null).length;
	// The filter of the menu, and of a new chat event. See `filterForChoice`. The last choice is the default
	// of the server: an agent gets only the messages for it.
	const filterOf = (event: WebhookEvent | null, id: string) =>
		filterForChoice(
			{ selected, saved, canAdd },
			event,
			id,
			filterChoice[id],
			defaultChatWebhookFilter(target.agent ? "agent" : "human"),
		);
	const filter = domain === "chat" ? filterOf(null, target.id) : undefined;

	// The handlers below are functions, so they do not keep the check that `target` exists.
	const shownId = target.id;

	/** Sets or clears one event of the target. A set event of Chat gets the filter of the menu. */
	function change(next: Set<string>, event: WebhookEvent, on: boolean) {
		next.delete(choiceKey(event, shownId));
		next.delete(choiceKey(event, shownId, "addressed"));
		if (on) next.add(choiceKey(event, shownId, domain === "chat" ? filterOf(event, shownId) : undefined));
	}

	function toggle(event: WebhookEvent) {
		const next = new Set(selected);
		change(next, event, chosenFilter(selected, event, shownId) === null);
		onChange(next);
	}

	function toggleAll() {
		const next = new Set(selected);
		const clear = set === offered.length;
		// A set event keeps its filter: a different filter needs a delete and a new subscription.
		for (const event of offered) {
			if (clear || chosenFilter(selected, event, shownId) === null) change(next, event, !clear);
		}
		onChange(next);
	}

	function changeFilter(value: ChatWebhookFilter) {
		setFilterChoice({ ...filterChoice, [shownId]: value });
		onChange(withChatFilter(selected, shownId, value));
	}

	return (
		<fieldset className="event-group" aria-describedby={describedBy ? `${hintId} ${describedBy}` : hintId}>
			<legend className="event-group-title">{DOMAIN_LABELS[domain]}</legend>
			<p id={hintId} className="field-hint">
				{DOMAIN_HINT[domain]}
			</p>
			{targets.length > 1 && (
				<div className="field event-target">
					<label htmlFor={targetId} className="field-label">
						Events of
					</label>
					<Select
						id={targetId}
						value={target.id}
						options={targets.map((candidate) => {
							const chosen = count(candidate.id);
							const description = chosen === 0 ? candidate.description : chosen === 1 ? "1 event" : `${chosen} events`;
							return { value: candidate.id, label: candidate.name, ...(description ? { description } : {}) };
						})}
						onChange={setShown}
						disabled={disabled}
					/>
				</div>
			)}
			{filter !== undefined && (
				<div className="field event-target event-filter">
					<label htmlFor={filterId} className="field-label">
						Messages
					</label>
					{/* A different filter deletes a subscription and adds it again, so it needs the right to add. */}
					<Select
						id={filterId}
						value={filter}
						options={FILTER_OPTIONS}
						onChange={changeFilter}
						disabled={disabled || !canAdd}
					/>
				</div>
			)}
			<div className="event-list">
				{all && (
					<label className="check-row event-all">
						<input
							type="checkbox"
							className="checkbox"
							checked={set === offered.length}
							ref={(input) => {
								if (input) input.indeterminate = set > 0 && set < offered.length;
							}}
							onChange={toggleAll}
							disabled={disabled}
							data-autofocus={autofocus ? true : undefined}
						/>
						<span>All {DOMAIN_LABELS[domain].toLowerCase()} events</span>
					</label>
				)}
				{events.map((event, index) => {
					const checked = chosenFilter(selected, event, target.id) !== null;
					return (
						<label key={choiceKey(event, target.id)} className="check-row">
							<input
								type="checkbox"
								className="checkbox"
								checked={checked}
								onChange={() => toggle(event)}
								disabled={locked(event)}
								data-autofocus={autofocus && !all && index === 0 ? true : undefined}
							/>
							<span>
								{EVENT_LABELS[event]}
								{stopped && chosenFilter(stopped, event, target.id) !== null && checked && (
									<span className="check-hint">Stopped. To start it again, clear it and save. Then set it.</span>
								)}
							</span>
						</label>
					);
				})}
			</div>
		</fieldset>
	);
}
