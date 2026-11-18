import type { ChatMessage } from "@soldock/contracts";

// The pure rules of the view of one thread. They have no DOM and no network, so apps/web/test checks them.

/** The view of one thread: the message that starts it, its replies oldest first, and the version of the read. */
export interface ThreadState {
	parent: ChatMessage;
	replies: readonly ChatMessage[];
	/** The version of the room at the last read of the thread. A catch-up reads the changes after it. */
	version: number;
}

/**
 * The thread with `messages` in it: the newer copy of the parent, and each new or newer reply of this
 * parent, in the order of the seq. A message of a different thread or of the room list changes nothing.
 * A copy that is not newer than the one that shows changes nothing, so the socket and a read can bring
 * the same message in each order.
 */
export function mergeThread(state: ThreadState, messages: readonly ChatMessage[]): ThreadState {
	let parent = state.parent;
	const replies = new Map(state.replies.map((reply) => [reply.id, reply]));
	let changed = false;
	for (const message of messages) {
		if (message.id === parent.id) {
			if (message.version > parent.version) {
				parent = message;
				changed = true;
			}
		} else if (message.parent_id === parent.id) {
			const shown = replies.get(message.id);
			if (!shown || message.version > shown.version) {
				replies.set(message.id, message);
				changed = true;
			}
		}
	}
	if (!changed) return state;
	return { ...state, parent, replies: [...replies.values()].sort((a, b) => a.seq - b.seq) };
}

/** True when a message of the socket belongs to the thread of `parentId`: the parent or one of its replies. */
export function inThread(message: Pick<ChatMessage, "id" | "parent_id">, parentId: string): boolean {
	return message.id === parentId || message.parent_id === parentId;
}
