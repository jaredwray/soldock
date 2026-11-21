import type { ChatNotificationLevel } from "@asterra/contracts";
import { useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import {
	NOTIFICATION_LEVELS,
	NotificationLevelOptions,
	useNotificationSettings,
} from "../../lib/chatNotificationSettings.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { Icon } from "../../lib/icons.tsx";

export function RoomNotificationButton({ roomId }: { roomId: string }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				className="icon-button"
				aria-label="Room notifications"
				title="Room notifications"
				onClick={() => setOpen(true)}
			>
				<Icon name="settings" />
			</button>
			{open && (
				<Dialog title="Room notifications" onClose={() => setOpen(false)}>
					<RoomPreferences roomId={roomId} onSaved={() => setOpen(false)} />
				</Dialog>
			)}
		</>
	);
}

function RoomPreferences({ roomId, onSaved }: { roomId: string; onSaved: () => void }) {
	const { data, loading } = useNotificationSettings();
	const [value, setValue] = useState<ChatNotificationLevel | "" | undefined>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	if (!data) return loading;
	const previous = data.settings.room_levels[roomId] ?? "";
	const selected = value ?? previous;
	return (
		<form
			className="panel-form"
			onSubmit={async (event) => {
				event.preventDefault();
				setBusy(true);
				setError("");
				try {
					await api.call("chat.set_room_notification_level", { room_id: roomId, level: selected || null });
					onSaved();
				} catch (reason) {
					setError(errorMessage(reason));
					setBusy(false);
				}
			}}
		>
			<label className="field">
				Notify me about
				<select
					className="input"
					value={selected}
					disabled={busy}
					onChange={(event) => setValue(event.target.value as ChatNotificationLevel | "")}
				>
					<option value="">Use my default ({NOTIFICATION_LEVELS[data.settings.default_level]})</option>
					<NotificationLevelOptions />
				</select>
			</label>
			{error && (
				<p role="alert" className="form-error">
					{error}
				</p>
			)}
			<button type="submit" disabled={busy || previous === selected} className="button button-primary">
				{busy ? "Saving…" : "Save"}
			</button>
		</form>
	);
}
