import { useEffect, useState } from "react";
import { Select, type SelectOption } from "../../lib/Select.tsx";
import { type SnoozePreset, snoozePresets, snoozeTime } from "./snooze.ts";

type Choice = SnoozePreset["key"] | "custom";

interface SnoozePickerProps {
	/** The class of the button, as for `Select`. */
	className: string;
	/** The accessible name of the button and of its list. */
	label: string;
	title?: string;
	/** Called with a time of the list. */
	onPick: (until: Date) => void;
	/** Called for "Pick a date and time…": the parent opens the dialog with the date field. */
	onCustom: () => void;
}

/**
 * The Snooze button: a list of times under the button, so one more click snoozes. The last option opens the
 * dialog for a date and a time of the person. The control has no value: each choice acts, and the button
 * shows "Snooze" again.
 */
export function SnoozePicker({ className, label, title, onPick, onCustom }: SnoozePickerProps) {
	// The times of the list change with the clock. A new minute shows them again.
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(new Date()), 60_000);
		return () => window.clearInterval(timer);
	}, []);

	const shown = snoozePresets(now);
	const options: SelectOption<Choice>[] = [
		...shown.map((preset) => ({
			value: preset.key,
			label: preset.label,
			description: snoozeTime(preset.at, now),
		})),
		{ value: "custom", label: "Pick a date and time…" },
	];

	function choose(choice: Choice) {
		if (choice === "custom") {
			onCustom();
			return;
		}
		// The time counts from the click, not from the last minute that the list showed. After midnight, the list
		// of now can be without the option that the person saw: the time that the list showed applies then.
		const find = (presets: readonly SnoozePreset[]) => presets.find((item) => item.key === choice);
		const preset = find(snoozePresets(new Date())) ?? find(shown);
		if (preset) onPick(preset.at);
	}

	return (
		<Select<Choice | "">
			className={className}
			label={label}
			title={title}
			icon="clock"
			value=""
			placeholder="Snooze"
			options={options}
			onChange={(choice) => {
				if (choice !== "") choose(choice);
			}}
		/>
	);
}
