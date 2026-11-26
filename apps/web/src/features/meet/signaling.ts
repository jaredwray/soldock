import {
	type CallState,
	type EndReason,
	MEET_SOCKET_CLOSE,
	MEET_SOCKET_SUBPROTOCOL,
	type MeetSocketMessage,
	meetSocketPath,
} from "@asterra/contracts";
import { callApi } from "./callApi.ts";

// The state of a meeting for this participant. The socket of the meeting sends each change at once. While the
// socket is down, the page polls the state, so a lost socket only makes the changes slower.

const POLL_MS = 3000;
const PING_MS = 20_000;
const MAX_BACKOFF_MS = 10_000;

export interface MeetingWatch {
	stop(): void;
	/** Reads the state now, for example after a change that this tab made. */
	refresh(): void;
}

export function watchMeeting(
	code: string,
	token: string,
	handlers: { state(state: CallState): void; closed(reason: EndReason | null): void },
): MeetingWatch {
	let stopped = false;
	let socket: WebSocket | null = null;
	let open = false;
	let backoff = 1000;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let pingTimer: ReturnType<typeof setInterval> | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let version = -1;

	const deliver = (state: CallState) => {
		if (stopped || state.version < version) return;
		version = state.version;
		handlers.state(state);
		if (state.self.state !== "waiting" && state.self.state !== "admitted") finish(state.self.end_reason);
		else if (state.meeting.status !== "open") finish(state.meeting.status === "cancelled" ? "cancelled" : "ended");
	};

	const finish = (reason: EndReason | null) => {
		if (stopped) return;
		stop();
		handlers.closed(reason);
	};

	const poll = async () => {
		pollTimer = null;
		if (stopped || open) return;
		try {
			deliver(await callApi.state(code, token));
		} catch (error) {
			const status = (error as { status?: number }).status;
			if (status === 401 || status === 403 || status === 404) return finish(null);
		}
		if (!stopped && !open) pollTimer = setTimeout(poll, POLL_MS);
	};

	const connect = () => {
		reconnectTimer = null;
		if (stopped) return;
		const scheme = window.location.protocol === "https:" ? "wss" : "ws";
		const ws = new WebSocket(`${scheme}://${window.location.host}${meetSocketPath(code)}`, [
			MEET_SOCKET_SUBPROTOCOL,
			`token.${token}`,
		]);
		socket = ws;
		ws.addEventListener("open", () => {
			open = true;
			backoff = 1000;
			if (pollTimer) clearTimeout(pollTimer);
			pollTimer = null;
			pingTimer = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) ws.send("ping");
			}, PING_MS);
		});
		ws.addEventListener("message", (event) => {
			if (event.data === "pong") return;
			let message: MeetSocketMessage;
			try {
				message = JSON.parse(String(event.data)) as MeetSocketMessage;
			} catch {
				return;
			}
			if (message.type === "state") deliver(message);
			else if (message.type === "closed") finish(message.reason);
		});
		ws.addEventListener("close", (event) => {
			if (socket !== ws) return;
			open = false;
			socket = null;
			if (pingTimer) clearInterval(pingTimer);
			pingTimer = null;
			if (stopped) return;
			if (event.code === MEET_SOCKET_CLOSE.replaced) return finish(null);
			if (event.code === MEET_SOCKET_CLOSE.refused || event.code === MEET_SOCKET_CLOSE.over) {
				// The state tells why.
				void poll();
				return;
			}
			if (!pollTimer) void poll();
			reconnectTimer = setTimeout(connect, backoff);
			backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
		});
	};

	const online = () => {
		if (stopped || open) return;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		backoff = 1000;
		connect();
	};

	function stop() {
		stopped = true;
		window.removeEventListener("online", online);
		if (pollTimer) clearTimeout(pollTimer);
		if (pingTimer) clearInterval(pingTimer);
		if (reconnectTimer) clearTimeout(reconnectTimer);
		const ws = socket;
		socket = null;
		ws?.close(1000, "The page left the meeting.");
	}

	window.addEventListener("online", online);
	void poll();
	connect();
	return {
		stop,
		refresh() {
			void callApi.state(code, token).then(deliver, () => {});
		},
	};
}
