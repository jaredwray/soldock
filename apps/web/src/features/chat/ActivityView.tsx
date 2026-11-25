import type { ChatActivityItem, ChatActivityKind } from "@asterra/contracts";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { setPageTitle } from "../../lib/pageTitle.ts";
import { navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { chatPath } from "../../routes.ts";
import { PageHeader } from "../../shell/PageHeader.tsx";
import { EmojiGlyph } from "./customEmoji.tsx";
import { MemberRequestActions } from "./MemberRequestActions.tsx";
import { requestOfActivity, requestRoomText } from "./memberRequests.ts";

type ActivityFilter = "all" | "unread" | ChatActivityKind;

const FILTERS: { value: ActivityFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "unread", label: "Unread" },
	{ value: "mention", label: "Mentions" },
	{ value: "reply", label: "Replies" },
	{ value: "reaction", label: "Reactions" },
	{ value: "reminder", label: "Reminders" },
	{ value: "card_action", label: "Card actions" },
	{ value: "member_request", label: "Member requests" },
];

function describeKind(item: ChatActivityItem): string {
	switch (item.kind) {
		case "mention":
			return "mentioned you";
		case "reply":
			return "replied in a thread you follow";
		case "reaction":
			return "reacted to your message";
		case "reminder":
			return "reminder is due";
		case "card_action":
			return "clicked a card button";
		case "member_request":
			return "asks to add";
	}
}

export function ActivityView({ tick, onReadChange }: { tick: number; onReadChange: () => void }) {
	const toast = useToast();
	const [filter, setFilter] = useState<ActivityFilter>("all");
	const [items, setItems] = useState<ChatActivityItem[]>([]);
	const [unreadCount, setUnreadCount] = useState(0);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setPageTitle("Activity – Chat – Asterra");
	}, []);

	const load = useCallback(
		async (cursor: string | null) => {
			if (!cursor) setLoading(true);
			setError(null);
			try {
				const res = await api.call("chat.list_activity", {
					filter,
					...(cursor ? { cursor } : {}),
				});
				setItems((current) => (cursor ? [...current, ...res.items] : res.items));
				setUnreadCount(res.unread_count);
				setNextCursor(res.next_cursor);
			} catch (caught) {
				setError(errorMessage(caught));
			} finally {
				setLoading(false);
			}
		},
		[filter],
	);

	useEffect(() => {
		void tick;
		void load(null);
	}, [load, tick]);

	async function markAllRead() {
		try {
			const res = await api.call("chat.mark_activity_read", {});
			setUnreadCount(res.unread_count);
			setItems((current) =>
				filter === "unread"
					? []
					: current.map((item) => ({ ...item, read_at: item.read_at ?? new Date().toISOString() })),
			);
			onReadChange();
		} catch (caught) {
			toast({ message: errorMessage(caught), tone: "error" });
		}
	}

	// The server removed the item with its request, so the unread count of the sidebar can be different.
	function removeRequest(item: ChatActivityItem) {
		setItems((current) => current.filter((other) => other.id !== item.id));
		if (item.read_at === null) setUnreadCount((current) => Math.max(0, current - 1));
		onReadChange();
	}

	async function openItem(item: ChatActivityItem) {
		if (item.read_at === null) {
			try {
				await api.call("chat.mark_activity_read", { activity_id: item.id });
				onReadChange();
			} catch {
				// Proceed to navigation even if mark read fails.
			}
		}
		if (item.parent_seq !== null) {
			navigate(chatPath(item.room_id, item.parent_seq, item.seq));
		} else {
			navigate(chatPath(item.room_id, item.seq));
		}
	}

	return (
		<div className="chat-subview">
			<PageHeader title="Activity" icon="bell" />
			<div className="chat-subview-bar" role="tablist" aria-label="Activity filters">
				{FILTERS.map((f) => (
					<button
						key={f.value}
						type="button"
						role="tab"
						aria-selected={filter === f.value}
						className={filter === f.value ? "chip chip-active" : "chip"}
						onClick={() => setFilter(f.value)}
					>
						{f.label}
					</button>
				))}
				{unreadCount > 0 && (
					<button type="button" className="button button-small" onClick={() => void markAllRead()}>
						Mark all read ({unreadCount})
					</button>
				)}
			</div>
			<div className="chat-subview-body">
				{loading && <p className="chat-empty">Loading activity…</p>}
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				{!loading && !error && items.length === 0 && (
					<div className="chat-empty">
						<Icon name="bell" size={24} />
						<p>No activity items here yet.</p>
					</div>
				)}
				<ul className="chat-feed-list">
					{items.map((item) => (
						<li key={item.id} className={item.read_at === null ? "chat-feed-item chat-feed-unread" : "chat-feed-item"}>
							{item.kind === "member_request" ? (
								// The person is usually not a member of the room, and the item is not about a message. So
								// the item is not a link: it has only the two buttons.
								<div className="chat-feed-card">
									<div className="chat-feed-head">
										<span className="chat-feed-actor">{item.actor.display_name}</span>{" "}
										<span className="chat-feed-action">{describeKind(item)}</span>{" "}
										<span className="chat-feed-actor">{requestOfActivity(item).subjectName}</span>
										{item.subject?.kind === "agent" && <span className="kind kind-agent">agent</span>}{" "}
										<span className="chat-feed-action">to {requestRoomText(item.room_name)}</span>
										<span className="chat-feed-time">{shortDate(item.created_at)}</span>
									</div>
									<p className="chat-feed-preview">
										You manage this account. The agent cannot add it to the room without your approval.
									</p>
									<MemberRequestActions request={requestOfActivity(item)} onGone={() => removeRequest(item)} />
								</div>
							) : (
								<button type="button" className="chat-feed-button" onClick={() => void openItem(item)}>
									<div className="chat-feed-head">
										<span className="chat-feed-actor">{item.actor.display_name}</span>{" "}
										<span className="chat-feed-action">{describeKind(item)}</span>
										{item.emoji && (
											<span className="chat-feed-emoji">
												<EmojiGlyph emoji={item.emoji} />
											</span>
										)}
										{item.room_name && <span className="chat-feed-room">in #{item.room_name}</span>}
										<span className="chat-feed-time">{shortDate(item.created_at)}</span>
									</div>
									{item.preview && <p className="chat-feed-preview">{item.preview}</p>}
								</button>
							)}
						</li>
					))}
				</ul>
				{nextCursor && (
					<p className="chat-subview-more">
						<button type="button" className="button" onClick={() => void load(nextCursor)}>
							Load more
						</button>
					</p>
				)}
			</div>
		</div>
	);
}
