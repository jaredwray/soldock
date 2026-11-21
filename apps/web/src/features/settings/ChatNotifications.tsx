import type { ChatDndSchedule, ChatNotificationLevel, ChatNotificationSettings, InputOf } from "@asterra/contracts";
import { useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { NotificationLevelOptions, useNotificationSettings } from "../../lib/chatNotificationSettings.tsx";
import { devicePushEnabled, disableDevicePush, enableDevicePush, supportsPush } from "../../lib/chatPush.ts";
import { useToast } from "../../lib/toast.tsx";
import { useSession } from "../auth/session.tsx";

export function ChatNotifications() {
	const { data, loading } = useNotificationSettings();
	const title = useId();
	return (
		<section className="panel" aria-labelledby={title}>
			<h2 className="panel-title" id={title}>
				Chat notifications
			</h2>
			{data ? (
				<>
					<PreferencesForm initial={data.settings} />
					<DevicePush publicKey={data.vapid_public_key} />
				</>
			) : (
				loading
			)}
		</section>
	);
}

function PreferencesForm({ initial }: { initial: ChatNotificationSettings }) {
	const [saved, setSaved] = useState(initial);
	const [level, setLevel] = useState(initial.default_level);
	const [sound, setSound] = useState(initial.sound);
	const [quiet, setQuiet] = useState(initial.dnd !== null);
	const [schedule, setSchedule] = useState<ChatDndSchedule>(
		initial.dnd ?? {
			start: "22:00",
			end: "07:00",
			time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		},
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const toast = useToast();
	const patch: InputOf<"chat.set_notification_settings"> = {};
	if (saved.default_level !== level) patch.default_level = level;
	if (saved.sound !== sound) patch.sound = sound;
	const dnd = quiet ? schedule : null;
	if (saved.dnd?.start !== dnd?.start || saved.dnd?.end !== dnd?.end || saved.dnd?.time_zone !== dnd?.time_zone)
		patch.dnd = dnd;

	return (
		<form
			className="panel-card panel-form"
			onSubmit={async (event) => {
				event.preventDefault();
				setBusy(true);
				setError("");
				try {
					const { settings } = await api.call("chat.set_notification_settings", patch);
					setSaved(settings);
					setLevel(settings.default_level);
					setSound(settings.sound);
					setQuiet(settings.dnd !== null);
					if (settings.dnd) setSchedule(settings.dnd);
					toast({ message: "Chat notification settings saved." });
				} catch (reason) {
					setError(errorMessage(reason));
				} finally {
					setBusy(false);
				}
			}}
		>
			<label className="field">
				Default for rooms
				<select
					className="input"
					value={level}
					disabled={busy}
					onChange={(event) => setLevel(event.target.value as ChatNotificationLevel)}
				>
					<NotificationLevelOptions />
				</select>
			</label>
			<label>
				<input type="checkbox" checked={sound} disabled={busy} onChange={(event) => setSound(event.target.checked)} />{" "}
				Play a sound for new messages
			</label>
			<label>
				<input type="checkbox" checked={quiet} disabled={busy} onChange={(event) => setQuiet(event.target.checked)} />{" "}
				Do not disturb
			</label>
			{quiet && (
				<>
					<label className="field">
						From
						<input
							className="input"
							type="time"
							required
							disabled={busy}
							value={schedule.start}
							onChange={(event) => setSchedule({ ...schedule, start: event.target.value })}
						/>
					</label>
					<label className="field">
						Until
						<input
							className="input"
							type="time"
							required
							disabled={busy}
							value={schedule.end}
							onChange={(event) => setSchedule({ ...schedule, end: event.target.value })}
						/>
					</label>
					<label className="field">
						Time zone
						<input
							className="input"
							required
							disabled={busy}
							maxLength={100}
							value={schedule.time_zone}
							onChange={(event) => setSchedule({ ...schedule, time_zone: event.target.value })}
						/>
					</label>
					<p className="field-hint">Quiet hours repeat each day. Use the same start and end time for the full day.</p>
				</>
			)}
			{error && (
				<p role="alert" className="form-error">
					{error}
				</p>
			)}
			<button type="submit" className="button button-primary" disabled={busy || !Object.keys(patch).length}>
				{busy ? "Saving…" : "Save notification settings"}
			</button>
		</form>
	);
}

function DevicePush({ publicKey }: { publicKey: string | null }) {
	const account = useSession().whoami.principal.id;
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let stopped = false;
		void devicePushEnabled(account, publicKey).then(
			(value) => {
				if (!stopped) setEnabled(value);
			},
			(reason) => {
				if (!stopped) {
					setEnabled(false);
					setError(errorMessage(reason));
				}
			},
		);
		return () => {
			stopped = true;
		};
	}, [account, publicKey]);
	const available = supportsPush() && publicKey !== null;
	return (
		<div className="panel-card panel-form">
			<p className="setting-action-title">Push notifications on this device</p>
			{!available && (
				<p className="field-hint">
					{publicKey
						? "This browser does not support Web Push."
						: "The administrator must configure Web Push for this site."}
				</p>
			)}
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<button
				type="button"
				className="button"
				disabled={(!enabled && !available) || busy || enabled === null}
				onClick={async () => {
					setBusy(true);
					setError("");
					try {
						if (enabled) await disableDevicePush(account);
						else if (publicKey) await enableDevicePush(account, publicKey);
						setEnabled(await devicePushEnabled(account, publicKey));
					} catch (reason) {
						setError(errorMessage(reason));
					} finally {
						setBusy(false);
					}
				}}
			>
				{enabled ? "Turn off device notifications" : "Turn on device notifications"}
			</button>
		</div>
	);
}
