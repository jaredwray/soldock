import type { ChatActivityEntry } from "@asterra/contracts";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fullDate, shortDate } from "../../lib/format.ts";
import { setPageTitle } from "../../lib/pageTitle.ts";
import { Link } from "../../lib/router.tsx";
import { chatPath } from "../../routes.ts";
import { PageHeader } from "../../shell/PageHeader.tsx";

export function ActivityView({ tick }: { tick: number }) {
	const [cursors, setCursors] = useState<(string | null)[]>([null]);
	const cursor = cursors.at(-1);
	const [result, setResult] = useState<{ activity: ChatActivityEntry[]; next_cursor: string | null } | null>(null);
	const [error, setError] = useState("");
	const [retry, setRetry] = useState(0);
	useEffect(() => {
		setPageTitle("Activity – Asterra");
	}, []);
	useEffect(() => {
		void tick;
		void retry;
		let active = true;
		setError("");
		api.call("chat.list_activity", cursor ? { cursor } : {}).then(
			(answer) => {
				if (active) setResult(answer);
			},
			(caught) => {
				if (active) {
					setError(errorMessage(caught));
					setResult(null);
				}
			},
		);
		return () => {
			active = false;
		};
	}, [cursor, tick, retry]);
	function turn(pages: (string | null)[]) {
		setResult(null);
		setCursors(pages);
	}
	return (
		<>
			<PageHeader title="Activity" icon="chat" />
			<div className="chat-threads">
				{error ? (
					<p role="alert">
						{error}{" "}
						<button type="button" className="button" onClick={() => setRetry(retry + 1)}>
							Try again
						</button>
					</p>
				) : result === null ? (
					<p role="status">Loading…</p>
				) : result.activity.length === 0 ? (
					<p>No activity on this page.</p>
				) : null}
				<ul className="chat-threads-list" aria-label="Mentions, replies and reactions">
					{result?.activity.map((entry) => (
						<li key={`${entry.room_id}/${entry.version}`}>
							<Link
								className="chat-thread-card"
								to={chatPath(
									entry.room_id,
									entry.parent_seq ?? entry.seq,
									entry.parent_seq === null ? null : entry.seq,
								)}
							>
								<strong>{entry.room_name}</strong>
								<span>
									{entry.actor_name}{" "}
									{entry.kind === "mention"
										? "mentioned you"
										: entry.kind === "reply"
											? "replied in a thread you follow"
											: `reacted ${entry.emoji} to your message`}
								</span>
								<time dateTime={entry.at} title={fullDate(entry.at)}>
									{shortDate(entry.at)}
								</time>
							</Link>
						</li>
					))}
				</ul>
				<div className="chat-threads-more">
					{cursors.length > 1 && (
						<button type="button" className="button" onClick={() => turn(cursors.slice(0, -1))}>
							Newer activity
						</button>
					)}
					{result?.next_cursor && (
						<button type="button" className="button" onClick={() => turn([...cursors, result.next_cursor])}>
							Older activity
						</button>
					)}
				</div>
			</div>
		</>
	);
}
