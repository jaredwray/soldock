import type { FeedbackStatus } from "@asterra/contracts";
import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";

/** The event that Admin › General sends after a change of the feedback settings. */
export const FEEDBACK_CHANGED_EVENT = "asterra:feedback-changed";

/**
 * The state of feedback for the signed-in person: one `feedback.get_status` call, and one more after a change in
 * Admin › General. Null until the answer arrives, and when the call fails: the shell then shows no button.
 */
export function useFeedbackStatus(): FeedbackStatus | null {
	const [status, setStatus] = useState<FeedbackStatus | null>(null);
	useEffect(() => {
		let live = true;
		const load = () => {
			api.call("feedback.get_status").then(
				(next) => {
					if (live) setStatus(next);
				},
				() => {
					if (live) setStatus(null);
				},
			);
		};
		load();
		window.addEventListener(FEEDBACK_CHANGED_EVENT, load);
		return () => {
			live = false;
			window.removeEventListener(FEEDBACK_CHANGED_EVENT, load);
		};
	}, []);
	return status;
}
