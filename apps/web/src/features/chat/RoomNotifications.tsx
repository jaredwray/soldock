import type { ChatNotificationLevel } from "@asterra/contracts";
import { useId } from "react";
import { NOTIFICATION_LEVELS } from "../../lib/chatNotificationSettings.tsx";

export type RoomNotificationChoice = ChatNotificationLevel | "default";

interface RoomNotificationChoicesProps {
	defaultLevel: ChatNotificationLevel;
	value: RoomNotificationChoice;
	onChange: (choice: RoomNotificationChoice) => void;
	disabled: boolean;
}

/** The member's own notification level, within the room settings form. */
export function RoomNotificationChoices({ defaultLevel, value, onChange, disabled }: RoomNotificationChoicesProps) {
	const groupId = useId();
	const options = [
		{ value: "default", label: "Use account default", hint: `Currently: ${NOTIFICATION_LEVELS[defaultLevel]}` },
		{ value: "all", label: NOTIFICATION_LEVELS.all },
		{ value: "mentions", label: NOTIFICATION_LEVELS.mentions },
		{ value: "none", label: "Mute room", hint: "Unread counts still update." },
	] as const;
	return (
		<fieldset className="room-notification-choices" disabled={disabled}>
			<legend className="visually-hidden">Notification level</legend>
			{options.map((option) => {
				const labelId = `${groupId}-${option.value}`;
				const hint = "hint" in option ? option.hint : null;
				return (
					<label key={option.value} className="room-notification-choice">
						<input
							type="radio"
							name={groupId}
							value={option.value}
							aria-labelledby={labelId}
							aria-describedby={hint ? `${labelId}-hint` : undefined}
							checked={value === option.value}
							onChange={() => onChange(option.value)}
						/>
						<span className={option.value === "default" ? "room-notification-default" : undefined}>
							<span id={labelId}>{option.label}</span>
							{hint && (
								<span id={`${labelId}-hint`} className="room-setting-hint">
									{hint}
								</span>
							)}
						</span>
					</label>
				);
			})}
		</fieldset>
	);
}
