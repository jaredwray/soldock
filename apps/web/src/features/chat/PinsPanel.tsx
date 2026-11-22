import type { ChatPin } from "@asterra/contracts";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useToast } from "../../lib/toast.tsx";

export function PinsPanel({
	roomId,
	canUnpin,
	onClose,
	onJump,
	onChanged,
}: {
	roomId: string;
	canUnpin: boolean;
	onClose: () => void;
	onJump: (seq: number) => void;
	onChanged: () => void;
}) {
	const toast = useToast();
	const [pins, setPins] = useState<ChatPin[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await api.call("chat.list_pins", { room_id: roomId });
			setPins(res.pins);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setLoading(false);
		}
	}, [roomId]);

	useEffect(() => {
		void load();
	}, [load]);

	async function unpin(messageId: string) {
		try {
			await api.call("chat.unpin_message", { room_id: roomId, message_id: messageId });
			setPins((current) => current.filter((p) => p.message.id !== messageId));
			onChanged();
			toast({ message: "Message unpinned." });
		} catch (caught) {
			toast({ message: errorMessage(caught), tone: "error" });
		}
	}

	return (
		<aside className="chat-pins-panel" aria-label="Pinned messages">
			<header className="chat-pins-header">
				<h2 className="chat-pins-title">Pinned messages ({pins.length})</h2>
				<button type="button" className="icon-button" aria-label="Close pins" onClick={onClose}>
					<Icon name="close" size={18} />
				</button>
			</header>
			<div className="chat-pins-body">
				{loading && <p className="field-hint">Loading pins…</p>}
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				{!loading && !error && pins.length === 0 && <p className="field-hint">No pinned messages in this room yet.</p>}
				<ul className="chat-feed-list">
					{pins.map((pin) => (
						<li key={pin.message.id} className="chat-feed-item">
							<div className="chat-feed-card">
								<div className="chat-feed-head">
									<span className="chat-feed-actor">{pin.message.author.display_name}</span>
									<span className="chat-feed-time">{shortDate(pin.pinned_at)}</span>
								</div>
								<p className="chat-feed-preview">{pin.message.text || "(attachment)"}</p>
								<div className="chat-feed-actions">
									<button type="button" className="button button-small" onClick={() => onJump(pin.message.seq)}>
										Jump
									</button>
									{canUnpin && (
										<button type="button" className="button button-small" onClick={() => void unpin(pin.message.id)}>
											Unpin
										</button>
									)}
								</div>
							</div>
						</li>
					))}
				</ul>
			</div>
		</aside>
	);
}
