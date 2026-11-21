import { CHAT_PRESENCE_LIMITS, type ChatActivity } from "@asterra/contracts";
import { useEffect } from "react";
import { onPrincipalConnection, sendPrincipalFrame } from "./principalSocket.ts";

const IDLE_MS = 5 * 60_000;
let lastInput = 0;
let shownRoom: string | null = null;
let reportRoom: (() => void) | undefined;

/** A preview of a public room does not display its messages. */
export function useViewedRoom(roomId: string | null): void {
	useEffect(() => {
		shownRoom = roomId;
		reportRoom?.();
		return () => {
			shownRoom = null;
			reportRoom?.();
		};
	}, [roomId]);
}

function focusedTab(): boolean {
	return document.visibilityState === "visible" && document.hasFocus();
}

/** A queued sound can arrive after the tab goes idle. Check the same activity as its next report. */
export function activeChatTab(): boolean {
	return focusedTab() && Date.now() - lastInput < IDLE_MS;
}

/** Each signed-in tab reports its own activity, including a tab outside Chat. */
export function usePrincipalActivity(): void {
	useEffect(() => {
		lastInput = Date.now();
		let reported: ChatActivity | null = null;
		function report(force = false) {
			const frame: ChatActivity = {
				type: "chat.activity",
				active: activeChatTab(),
				room_id: focusedTab() ? shownRoom : null,
			};
			if (force || frame.active !== reported?.active || frame.room_id !== reported?.room_id) {
				sendPrincipalFrame(frame);
				reported = frame;
			}
		}
		const update = () => report();
		const input = () => {
			lastInput = Date.now();
			if (!reported?.active) report();
		};
		const unsubscribe = onPrincipalConnection((live) => {
			if (live) report(true);
		});
		reportRoom = update;
		report(true);
		const timer = window.setInterval(() => report(true), CHAT_PRESENCE_LIMITS.heartbeatMs);
		document.addEventListener("visibilitychange", update);
		window.addEventListener("focus", input);
		window.addEventListener("blur", update);
		document.addEventListener("keydown", input);
		document.addEventListener("pointerdown", input);
		document.addEventListener("scroll", input, true);
		return () => {
			reportRoom = undefined;
			unsubscribe();
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", update);
			window.removeEventListener("focus", input);
			window.removeEventListener("blur", update);
			document.removeEventListener("keydown", input);
			document.removeEventListener("pointerdown", input);
			document.removeEventListener("scroll", input, true);
		};
	}, []);
}
