import type { ChatNotificationLevel, OutputOf } from "@asterra/contracts";
import { useEffect, useState } from "react";
import { api, errorMessage } from "./api.ts";

export const NOTIFICATION_LEVELS: Record<ChatNotificationLevel, string> = {
	all: "All messages",
	mentions: "Mentions only",
	none: "No messages",
};

export function NotificationLevelOptions() {
	return Object.entries(NOTIFICATION_LEVELS).map(([value, label]) => (
		<option value={value} key={value}>
			{label}
		</option>
	));
}

export function useNotificationSettings() {
	const [data, setData] = useState<OutputOf<"chat.get_notification_settings"> | null>(null);
	const [error, setError] = useState("");
	const [attempt, setAttempt] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Try again starts a new read after a failure.
	useEffect(() => {
		let stopped = false;
		setError("");
		api.call("chat.get_notification_settings", {}).then(
			(result) => {
				if (!stopped) setData(result);
			},
			(reason) => {
				if (!stopped) setError(errorMessage(reason));
			},
		);
		return () => {
			stopped = true;
		};
	}, [attempt]);
	const loading = error ? (
		<div>
			<p className="form-error" role="alert">
				{error}
			</p>
			<button type="button" className="button" onClick={() => setAttempt(attempt + 1)}>
				Try again
			</button>
		</div>
	) : (
		<p role="status">Loading…</p>
	);
	return { data, loading };
}
