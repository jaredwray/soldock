import { type FormEvent, useId, useState } from "react";
import { Dialog } from "../../lib/Dialog.tsx";
import { plural } from "../../lib/format.ts";
import { snoozeInput, snoozePresets, snoozeTime, toDateTimeInput } from "./snooze.ts";

interface SnoozeDialogProps {
	/** The number of conversations that the snooze takes out of the inbox. */
	count: number;
	onClose: () => void;
	/** Called with the time that the person picked. The dialog does not close itself. */
	onPick: (until: Date) => void;
}

/**
 * The dialog of Snooze: the person picks a time that the dialog offers, or a date and a time of their own.
 * The conversations then leave the inbox and come back at that time.
 */
export function SnoozeDialog({ count, onClose, onPick }: SnoozeDialogProps) {
	// The times stay the same while the dialog is open.
	const [now] = useState(() => new Date());
	const presets = snoozePresets(now);
	const [value, setValue] = useState(() => toDateTimeInput(presets.find((item) => item.key === "tomorrow")?.at ?? now));
	const [error, setError] = useState<string | null>(null);
	const inputId = useId();
	const errorId = useId();

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const until = snoozeInput(value, new Date());
		if (!until) {
			setError("Pick a date and a time that are later than now.");
			return;
		}
		onPick(until);
	}

	return (
		<Dialog
			title="Snooze until"
			description={
				count === 1
					? "The conversation leaves the inbox and comes back at this time."
					: `The ${plural(count, "conversation")} leave the inbox and come back at this time.`
			}
			onClose={onClose}
			className="dialog-small"
		>
			<form onSubmit={submit} noValidate>
				<div className="dialog-body">
					<ul className="snooze-presets">
						{presets.map((preset, index) => (
							<li key={preset.key}>
								<button
									type="button"
									className="button snooze-preset"
									onClick={() => onPick(preset.at)}
									data-autofocus={index === 0 ? true : undefined}
								>
									<span>{preset.label}</span>
									<span className="snooze-preset-time">{snoozeTime(preset.at, now)}</span>
								</button>
							</li>
						))}
					</ul>
					<label htmlFor={inputId} className="field-label">
						Pick a date and a time
					</label>
					<input
						id={inputId}
						type="datetime-local"
						className="input"
						value={value}
						min={toDateTimeInput(now)}
						onChange={(event) => {
							setValue(event.target.value);
							setError(null);
						}}
						aria-describedby={error ? errorId : undefined}
						aria-invalid={error ? true : undefined}
					/>
					{error && (
						<p id={errorId} className="form-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<div className="dialog-actions">
					<button type="button" className="button" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="button button-primary">
						Snooze
					</button>
				</div>
			</form>
		</Dialog>
	);
}
