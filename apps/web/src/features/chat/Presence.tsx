import { CHAT_PRESENCE_LIMITS, type ChatPresence, type ChatStatus } from "@asterra/contracts";
import { createContext, type ReactNode, useContext, useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";

type Target = { id: string; visible: boolean; update: (principal: ChatPresence | null) => void };

/** One observer and one read loop serve all visible names, including names in a scrollable list. */
function createPresenceReader() {
	const targets = new Map<Element, Target>();
	let observer: IntersectionObserver | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running = false;
	let changed = false;
	let lastRead = 0;

	function schedule() {
		changed = true;
		if (running || targets.size === 0) return;
		clearTimeout(timer);
		timer = setTimeout(read, Math.max(100, lastRead + 1000 - Date.now()));
	}

	async function read() {
		if (document.visibilityState !== "visible") return;
		const ids = [...new Set([...targets.values()].filter((target) => target.visible).map((target) => target.id))];
		if (ids.length === 0) return;
		running = true;
		changed = false;
		lastRead = Date.now();
		try {
			for (let start = 0; start < ids.length && targets.size > 0; start += CHAT_PRESENCE_LIMITS.batch) {
				const batch = ids.slice(start, start + CHAT_PRESENCE_LIMITS.batch);
				const { principals } = await api.call("chat.get_presence", { principal_ids: batch.join(",") });
				const result = new Map(principals.map((principal) => [principal.principal_id, principal]));
				for (const target of targets.values()) {
					if (target.visible && batch.includes(target.id)) target.update(result.get(target.id) ?? null);
				}
			}
		} catch {
			// The next read can succeed after a lost connection.
			for (const target of targets.values()) target.update(null);
		} finally {
			running = false;
			if (targets.size > 0) {
				if (changed) schedule();
				else timer = setTimeout(read, CHAT_PRESENCE_LIMITS.refreshMs);
			}
		}
	}

	function watch(element: Element, id: string, update: Target["update"]) {
		if (targets.size === 0) {
			document.addEventListener("visibilitychange", schedule);
			observer = new IntersectionObserver((entries) => {
				for (const entry of entries) {
					const target = targets.get(entry.target);
					if (target) target.visible = entry.isIntersecting;
				}
				schedule();
			});
		}
		targets.set(element, { id, visible: false, update });
		observer?.observe(element);
		return () => {
			observer?.unobserve(element);
			targets.delete(element);
			if (targets.size === 0) {
				clearTimeout(timer);
				observer?.disconnect();
				document.removeEventListener("visibilitychange", schedule);
			}
		};
	}
	return { watch, refresh: schedule };
}

const PresenceContext = createContext<ReturnType<typeof createPresenceReader> | null>(null);

export function PresenceProvider({ children }: { children: ReactNode }) {
	const [reader] = useState(createPresenceReader);
	return <PresenceContext.Provider value={reader}>{children}</PresenceContext.Provider>;
}

const AVAILABILITY = { active: "Active", away: "Away", offline: "Offline" } as const;

/**
 * An agent works through MCP or REST and opens no events socket, so its availability is always offline.
 * For an agent, show only the custom status. A compact view shows only the dot, so it shows nothing for an agent.
 */
export function Presence({
	id,
	agent = false,
	compact = false,
	editable = false,
}: {
	id: string;
	agent?: boolean;
	compact?: boolean;
	editable?: boolean;
}) {
	const reader = useContext(PresenceContext);
	const ref = useRef<HTMLSpanElement>(null);
	const [presence, setPresence] = useState<ChatPresence | null>(null);
	const [editing, setEditing] = useState(false);
	const hidden = agent && compact;
	useEffect(() => {
		setPresence(null);
		if (!hidden && ref.current && reader) return reader.watch(ref.current, id, setPresence);
	}, [id, reader, hidden]);
	const status = presence?.status;
	// Each read replaces the snapshot. Near the end time, clear the label between two reads.
	useEffect(() => {
		const end = status?.expires_at;
		if (!end) return;
		const remaining = Date.parse(end) - Date.now();
		if (remaining > CHAT_PRESENCE_LIMITS.refreshMs * 2) return;
		const timer = setTimeout(
			() => setPresence((value) => (value?.status?.expires_at === end ? { ...value, status: null } : value)),
			Math.max(0, remaining),
		);
		return () => clearTimeout(timer);
	}, [status]);
	const detail = status ? [status.emoji, status.text].filter(Boolean).join(" ") : "";
	const availability = presence && !agent ? AVAILABILITY[presence.availability] : "";
	const label = [availability, detail].filter(Boolean).join(" · ");
	if (hidden) return null;
	return (
		<>
			<span ref={ref} className="chat-presence" title={compact && label ? label : undefined}>
				{presence && !agent && (
					<span className={`chat-presence-dot chat-presence-${presence.availability}`} aria-hidden="true" />
				)}
				<span className={compact ? "visually-hidden" : undefined}>{label}</span>
			</span>
			{editable && (
				<button type="button" className="button button-small" disabled={!presence} onClick={() => setEditing(true)}>
					Set status
				</button>
			)}
			{editing && (
				<StatusDialog
					initial={presence?.status ?? null}
					onClose={() => setEditing(false)}
					onSaved={(next) => {
						setPresence((current) => current && { ...current, status: next });
						setEditing(false);
						reader?.refresh();
					}}
				/>
			)}
		</>
	);
}

function localTime(iso: string | null | undefined): string {
	if (!iso) return "";
	const date = new Date(iso);
	return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function StatusDialog({
	initial,
	onClose,
	onSaved,
}: {
	initial: ChatStatus | null;
	onClose(): void;
	onSaved(status: ChatStatus | null): void;
}) {
	const [text, setText] = useState(initial?.text ?? "");
	const [emoji, setEmoji] = useState(initial?.emoji ?? "");
	const [end, setEnd] = useState(localTime(initial?.expires_at));
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const id = useId();
	async function save(status: ChatStatus | null) {
		setBusy(true);
		setError("");
		try {
			const result = await api.call("chat.set_status", { status });
			onSaved(result.status);
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}
	return (
		<Dialog title="Set status" onClose={() => !busy && onClose()} className="dialog-small">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void save({ text: text.trim(), emoji: emoji.trim(), expires_at: end ? new Date(end).toISOString() : null });
				}}
			>
				<div className="dialog-body chat-form">
					<label className="field-label" htmlFor={`${id}-text`}>
						Status
					</label>
					<input
						className="input"
						id={`${id}-text`}
						maxLength={100}
						value={text}
						onChange={(event) => setText(event.target.value)}
						data-autofocus
					/>
					<label className="field-label" htmlFor={`${id}-emoji`}>
						Emoji
					</label>
					<input
						className="input"
						id={`${id}-emoji`}
						maxLength={32}
						value={emoji}
						onChange={(event) => setEmoji(event.target.value)}
					/>
					<label className="field-label" htmlFor={`${id}-end`}>
						Clear at (optional)
					</label>
					<input
						className="input"
						id={`${id}-end`}
						type="datetime-local"
						min={localTime(new Date().toISOString())}
						value={end}
						onChange={(event) => setEnd(event.target.value)}
					/>
					{error && (
						<p role="alert" className="form-error">
							{error}
						</p>
					)}
				</div>
				<div className="dialog-actions">
					{initial && (
						<button type="button" className="button" disabled={busy} onClick={() => void save(null)}>
							Clear status
						</button>
					)}
					<button type="button" className="button" disabled={busy} onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="button button-primary" disabled={busy || (!text.trim() && !emoji.trim())}>
						Save
					</button>
				</div>
			</form>
		</Dialog>
	);
}
