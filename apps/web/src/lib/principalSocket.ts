import { type ChatActivity, EVENTS_SOCKET_PATH, EVENTS_SOCKET_PROTOCOL, PrincipalEvent } from "@asterra/contracts";
import { createLiveSocket, type LiveSocket } from "../features/chat/socket.ts";

const listeners = new Set<(event: PrincipalEvent) => void>();
const connections = new Set<(live: boolean) => void>();
let connection: LiveSocket | null = null;
let live = false;

export function onPrincipalEvent(listener: (event: PrincipalEvent) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function onPrincipalConnection(listener: (live: boolean) => void): () => void {
	connections.add(listener);
	return () => {
		connections.delete(listener);
	};
}

export function principalSocketLive(): boolean {
	return live;
}

export function sendPrincipalFrame(frame: ChatActivity): void {
	connection?.send(JSON.stringify(frame));
}

/** Each signed-in tab has one socket. It stays open when the person leaves Chat. */
export function startPrincipalSocket(): () => void {
	const socket = createLiveSocket<PrincipalEvent>({
		connect(handlers) {
			const url = new URL(EVENTS_SOCKET_PATH, window.location.href);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			const opened = new WebSocket(url);
			opened.onmessage = (event) => handlers.message(event.data);
			opened.onclose = (event) => handlers.close(event.code);
			return { send: (data) => opened.send(data), close: () => opened.close(1000) };
		},
		parse(value) {
			const event = PrincipalEvent.safeParse(value);
			return event.success ? event.data : null;
		},
		protocol: EVENTS_SOCKET_PROTOCOL,
		onLive(next) {
			live = next;
			for (const listener of connections) listener(next);
		},
		onEvent(event) {
			for (const listener of listeners) listener(event);
		},
	});
	connection = socket;
	const wake = () => {
		if (document.visibilityState === "visible") socket.wake();
	};
	document.addEventListener("visibilitychange", wake);
	window.addEventListener("focus", wake);
	window.addEventListener("online", wake);
	return () => {
		socket.close();
		connection = null;
		document.removeEventListener("visibilitychange", wake);
		window.removeEventListener("focus", wake);
		window.removeEventListener("online", wake);
	};
}
