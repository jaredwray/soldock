import { useEffect } from "react";
import { calendarPath } from "../routes.ts";
import { onPrincipalEvent } from "./principalSocket.ts";
import { navigate } from "./router.tsx";
import { useToast } from "./toast.tsx";

/**
 * Shows a toast for each calendar reminder that the events socket sends, in each page of the app. The same
 * reminder is in the Activity of Chat, and on the devices of the person when they turned on notifications.
 */
export function useCalendarReminders(): void {
	const toast = useToast();
	useEffect(() => {
		return onPrincipalEvent((event) => {
			if (event.type !== "calendar.reminder") return;
			const start = Date.parse(event.start);
			const time = new Date(start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
			const date = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(
				start,
			);
			toast({
				message: `${event.title} starts at ${time}.`,
				action: { label: "Open", run: () => navigate(calendarPath("week", date)) },
			});
		});
	}, [toast]);
}
