import type { WebhookDomain } from "@soldock/contracts";
import { useId, useState } from "react";
import { Select } from "../../lib/Select.tsx";
import { choiceKey, DOMAIN_LABELS, EVENT_LABELS, eventsOf } from "./webhookModel.ts";

/** A mailbox, a person, an agent or a drive whose events a webhook can send. */
export interface PickerTarget {
	id: string;
	name: string;
	/** Muted text after the name in the menu, for example the address of a mailbox. */
	description?: string;
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
	disabled: boolean;
}

const DOMAIN_HINT: Record<WebhookDomain, string> = {
	mail: "The POST has no mail content. The receiver reads the inbox with its own key.",
	chat: "The POST has no message text.",
	drive: "The POST has no file content. A star sends nothing.",
};

/**
 * The check boxes of a webhook: one for each event of each product. A product with more than one
 * target has a menu. The check boxes show the events of the target in the menu.
 */
export function EventPicker({ groups, selected, onChange, canAdd, saved, disabled }: EventPickerProps) {
	return (
		<div className="event-groups">
			{groups.map((group) => (
				<EventGroup
					key={group.domain}
					group={group}
					selected={selected}
					onChange={onChange}
					canAdd={canAdd}
					saved={saved}
					disabled={disabled}
				/>
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
	disabled,
}: Omit<EventPickerProps, "groups"> & { group: PickerGroup }) {
	const { domain, targets } = group;
	const events = eventsOf(domain);
	const targetId = useId();
	const hintId = useId();
	const count = (id: string) => events.filter((event) => selected.has(choiceKey(event, id))).length;
	// The menu starts at the first target that has an event, so an edit shows the current events.
	const [shown, setShown] = useState(() => (targets.find((target) => count(target.id) > 0) ?? targets[0])?.id ?? "");
	const target = targets.find((candidate) => candidate.id === shown) ?? targets[0];
	if (!target) return null;

	const locked = (key: string) => disabled || (!canAdd && !saved.has(key));
	const keys = events.map((event) => choiceKey(event, target.id));
	const set = keys.filter((key) => selected.has(key)).length;

	function toggle(key: string) {
		const next = new Set(selected);
		if (!next.delete(key)) next.add(key);
		onChange(next);
	}

	function toggleAll() {
		const next = new Set(selected);
		const clear = set === keys.length;
		for (const key of keys) {
			if (clear) next.delete(key);
			else next.add(key);
		}
		onChange(next);
	}

	return (
		<fieldset className="event-group" aria-describedby={hintId}>
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
			<div className="event-list">
				{events.length > 1 && canAdd && (
					<label className="check-row event-all">
						<input
							type="checkbox"
							className="checkbox"
							checked={set === keys.length}
							ref={(input) => {
								if (input) input.indeterminate = set > 0 && set < keys.length;
							}}
							onChange={toggleAll}
							disabled={disabled}
						/>
						<span>All {DOMAIN_LABELS[domain].toLowerCase()} events</span>
					</label>
				)}
				{events.map((event) => {
					const key = choiceKey(event, target.id);
					return (
						<label key={key} className="check-row">
							<input
								type="checkbox"
								className="checkbox"
								checked={selected.has(key)}
								onChange={() => toggle(key)}
								disabled={locked(key)}
							/>
							<span>{EVENT_LABELS[event]}</span>
						</label>
					);
				})}
			</div>
		</fieldset>
	);
}
