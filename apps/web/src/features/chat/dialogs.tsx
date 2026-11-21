import { CHAT_LIMITS, type ChatMember, type ChatRoom, type ChatSection } from "@asterra/contracts";
import {
	type FormEvent,
	type RefObject,
	useCallback,
	useEffect,
	useEffectEvent,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { accountChangeCount } from "../../lib/account.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { useNotificationSettings } from "../../lib/chatNotificationSettings.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { initials, plural } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Select } from "../../lib/Select.tsx";
import { useToast } from "../../lib/toast.tsx";
import { principalOption, usePrincipals } from "../../lib/usePrincipals.ts";
import { useSession } from "../auth/session.tsx";
import { roomTitle } from "./model.ts";
import { Presence } from "./Presence.tsx";
import { RoomAdvancedSettings } from "./RoomAdvancedSettings.tsx";
import { type RoomNotificationChoice, RoomNotificationChoices } from "./RoomNotifications.tsx";

/** Creates a public or a private room. The person becomes its owner. */
export function NewRoomDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (room: ChatRoom) => void }) {
	const [name, setName] = useState("");
	const [topic, setTopic] = useState("");
	const [kind, setKind] = useState<"public" | "private">("public");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nameId = useId();
	const topicId = useId();

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!name.trim()) {
			setError("Enter a name.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const { room } = await api.call("chat.create_room", {
				kind,
				name: name.trim(),
				...(topic.trim() ? { topic: topic.trim() } : {}),
			});
			onCreated(room);
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog title="New room" onClose={() => !busy && onClose()} className="dialog-small">
			<form onSubmit={submit} noValidate>
				<div className="dialog-body chat-form">
					<div className="field">
						<label htmlFor={nameId} className="field-label">
							Room name
						</label>
						<input
							id={nameId}
							className="input"
							value={name}
							maxLength={CHAT_LIMITS.nameChars}
							autoComplete="off"
							onChange={(event) => setName(event.target.value)}
							aria-invalid={error && !name.trim() ? true : undefined}
							data-autofocus
						/>
					</div>
					<fieldset className="segmented">
						<legend className="field-label">Who can find the room</legend>
						{(["public", "private"] as const).map((value) => (
							<label key={value} className={kind === value ? "segment segment-active" : "segment"}>
								<input
									type="radio"
									name="room-kind"
									value={value}
									checked={kind === value}
									onChange={() => setKind(value)}
									disabled={busy}
								/>
								{value === "public" ? "Public" : "Private"}
							</label>
						))}
					</fieldset>
					<p className="field-hint">
						{kind === "public"
							? "Each person and each agent of the organization can find and join a public room."
							: "Only the members can find a private room. A member adds each new member."}
					</p>
					<div className="field">
						<label htmlFor={topicId} className="field-label">
							Topic (optional)
						</label>
						<input
							id={topicId}
							className="input"
							value={topic}
							maxLength={CHAT_LIMITS.topicChars}
							autoComplete="off"
							onChange={(event) => setTopic(event.target.value)}
						/>
					</div>
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<div className="dialog-actions">
					<button type="button" className="button" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" className="button button-primary" disabled={busy}>
						{busy ? "Creating…" : "Create"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

interface Browse {
	status: "loading" | "ready" | "error";
	rooms: ChatRoom[];
	nextCursor: string | null;
	error: string | null;
}

/** The public rooms of the organization. The person opens a room that they joined, or joins a room. */
export function BrowseRoomsDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (room: ChatRoom) => void }) {
	const [query, setQuery] = useState("");
	const [applied, setApplied] = useState("");
	const [state, setState] = useState<Browse>({ status: "loading", rooms: [], nextCursor: null, error: null });
	const [busyId, setBusyId] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const latest = useRef(0);
	const queryId = useId();

	/** Gets the first page of a query, or the page after `cursor`. Only the answer of the last call shows. */
	const load = useCallback(async (text: string, cursor: string | null) => {
		const request = ++latest.current;
		try {
			const page = await api.call("chat.list_rooms", {
				view: "public",
				...(text ? { query: text } : {}),
				...(cursor ? { cursor } : {}),
			});
			if (request !== latest.current) return;
			setState((current) => ({
				status: "ready",
				rooms: cursor ? [...current.rooms, ...page.rooms] : page.rooms,
				nextCursor: page.next_cursor,
				error: null,
			}));
		} catch (caught) {
			if (request !== latest.current) return;
			setState((current) => ({ ...current, status: "error", error: errorMessage(caught) }));
		}
	}, []);

	useEffect(() => {
		setState({ status: "loading", rooms: [], nextCursor: null, error: null });
		void load(applied, null);
	}, [applied, load]);

	async function more(cursor: string) {
		setLoadingMore(true);
		await load(applied, cursor);
		setLoadingMore(false);
	}

	async function join(room: ChatRoom) {
		setBusyId(room.id);
		try {
			const joined = await api.call("chat.join_room", { room_id: room.id });
			onOpen(joined.room);
		} catch (caught) {
			setState((current) => ({ ...current, error: errorMessage(caught) }));
			setBusyId(null);
		}
	}

	return (
		<Dialog title="Public rooms" onClose={onClose} description="Each person and each agent can join a public room.">
			<form
				className="chat-browse-search"
				onSubmit={(event) => {
					event.preventDefault();
					setApplied(query.trim());
				}}
			>
				<label htmlFor={queryId} className="visually-hidden">
					Part of a room name
				</label>
				<input
					id={queryId}
					className="input"
					type="search"
					placeholder="Part of a room name"
					value={query}
					maxLength={CHAT_LIMITS.queryChars}
					autoComplete="off"
					onChange={(event) => setQuery(event.target.value)}
					data-autofocus
				/>
				<button type="submit" className="button">
					Find
				</button>
			</form>
			{state.error && (
				<p className="form-error" role="alert">
					{state.error}
				</p>
			)}
			<div className="dialog-body chat-dialog-scroll">
				{state.status === "loading" && (
					<p className="list-state" role="status">
						<span className="spinner" aria-hidden="true" />
						Loading…
					</p>
				)}
				{state.status === "ready" && state.rooms.length === 0 && (
					<p className="list-state">
						{applied ? "No public room has that text in its name." : "The organization has no public room yet."}
					</p>
				)}
				<ul className="chat-rows">
					{state.rooms.map((room) => (
						<li key={room.id} className="chat-row">
							<span className="chat-row-tile" aria-hidden="true">
								<Icon name="hash" size={18} />
							</span>
							<span className="chat-row-text">
								<strong>{room.name}</strong>
								<span className="muted">
									{plural(room.member_count, "member")}
									{room.topic && ` · ${room.topic}`}
								</span>
							</span>
							{room.role === null ? (
								<button
									type="button"
									className="button button-small button-primary"
									disabled={busyId !== null}
									onClick={() => void join(room)}
								>
									{busyId === room.id ? "Joining…" : "Join"}
								</button>
							) : (
								<button type="button" className="button button-small" onClick={() => onOpen(room)}>
									Open
								</button>
							)}
						</li>
					))}
				</ul>
				{state.nextCursor && (
					<p className="chat-more">
						<button
							type="button"
							className="button"
							disabled={loadingMore}
							onClick={() => state.nextCursor && void more(state.nextCursor)}
						>
							{loadingMore ? "Loading…" : "Show more rooms"}
						</button>
					</p>
				)}
			</div>
			<div className="dialog-actions">
				<button type="button" className="button" onClick={onClose}>
					Close
				</button>
			</div>
		</Dialog>
	);
}

/** Opens a 1:1 direct message or a group direct message with people or agents. */
export function NewDmDialog({ onClose, onOpened }: { onClose: () => void; onOpened: (room: ChatRoom) => void }) {
	const ownId = useSession().whoami.principal.id;
	const principals = usePrincipals();
	const [filter, setFilter] = useState("");
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const filterId = useId();
	const words = filter.trim().toLowerCase();
	const others = (principals ?? []).filter(
		(principal) =>
			principal.id !== ownId &&
			(words === "" ||
				principal.display_name.toLowerCase().includes(words) ||
				principal.address.toLowerCase().includes(words)),
	);

	function toggle(principalId: string) {
		setSelectedIds((current) => {
			if (current.includes(principalId)) return current.filter((id) => id !== principalId);
			if (current.length >= CHAT_LIMITS.groupDmOthersMax) return current;
			return [...current, principalId];
		});
	}

	async function openSelected() {
		if (selectedIds.length === 0 || busy) return;
		setBusy(true);
		setError(null);
		try {
			const first = selectedIds[0];
			if (selectedIds.length === 1 && first) {
				const { room } = await api.call("chat.open_dm", { principal_id: first });
				onOpened(room);
			} else {
				const { room } = await api.call("chat.open_group_dm", { principal_ids: selectedIds });
				onOpened(room);
			}
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog title="New direct message" onClose={() => !busy && onClose()} className="dialog-small">
			<div className="chat-browse-search">
				<label htmlFor={filterId} className="visually-hidden">
					Name or address
				</label>
				<input
					id={filterId}
					className="input"
					type="search"
					placeholder="Pick 1 person for DM, or up to 8 for group DM"
					value={filter}
					autoComplete="off"
					onChange={(event) => setFilter(event.target.value)}
					data-autofocus
				/>
			</div>
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<div className="dialog-body chat-dialog-scroll">
				{principals === null && (
					<p className="list-state" role="status">
						<span className="spinner" aria-hidden="true" />
						Loading…
					</p>
				)}
				{principals !== null && others.length === 0 && <p className="list-state">No person or agent matches.</p>}
				<ul className="chat-rows">
					{others.map((principal) => {
						const checked = selectedIds.includes(principal.id);
						return (
							<li key={principal.id}>
								<button
									type="button"
									className={checked ? "chat-row chat-row-button chat-row-selected" : "chat-row chat-row-button"}
									aria-pressed={checked}
									disabled={busy}
									onClick={() => toggle(principal.id)}
								>
									<span className="avatar avatar-small" aria-hidden="true">
										{initials(principal.display_name)}
									</span>
									<span className="chat-row-text">
										<span className="chat-row-name">
											<strong>{principal.display_name}</strong>
											{principal.kind === "agent" && <span className="kind kind-agent">agent</span>}
										</span>
										<span className="muted">{principal.address}</span>
									</span>
									{checked && <Icon name="check" size={16} />}
								</button>
							</li>
						);
					})}
				</ul>
			</div>
			<div className="dialog-actions">
				<button type="button" className="button" onClick={onClose} disabled={busy}>
					Cancel
				</button>
				<button
					type="button"
					className="button button-primary"
					disabled={busy || selectedIds.length === 0}
					onClick={() => void openSelected()}
				>
					{busy ? "Opening…" : selectedIds.length > 1 ? `Open group DM (${selectedIds.length})` : "Open direct message"}
				</button>
			</div>
		</Dialog>
	);
}

interface MembersDialogProps {
	room: ChatRoom;
	onClose: () => void;
	/** After a member was added or removed. */
	onChanged: () => void;
	/** After the person left the room. */
	onLeft: () => void;
}

/**
 * The members of a room. Each member adds people and agents. The owner removes a member. Each member
 * can leave. A direct message keeps its two members, so it shows the list only.
 */
export function MembersDialog({ room, onClose, onChanged, onLeft }: MembersDialogProps) {
	const ownId = useSession().whoami.principal.id;
	const principals = usePrincipals();
	const [members, setMembers] = useState<ChatMember[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [principalId, setPrincipalId] = useState("");
	const personId = useId();
	const fixed = room.kind === "dm";

	const load = useCallback(async () => {
		try {
			setMembers((await api.call("chat.get_room", { room_id: room.id })).members);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [room.id]);

	useEffect(() => {
		void load();
	}, [load]);

	async function run(action: () => Promise<void>) {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (caught) {
			setError(errorMessage(caught));
		}
		setBusy(false);
	}

	const add = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!principalId) return;
		void run(async () => {
			await api.call("chat.add_members", { room_id: room.id, principal_ids: [principalId] });
			setPrincipalId("");
			await load();
			onChanged();
		});
	};

	const remove = (member: ChatMember) =>
		run(async () => {
			await api.call("chat.remove_member", { room_id: room.id, principal_id: member.principal_id });
			await load();
			onChanged();
		});

	const leave = () =>
		run(async () => {
			await api.call("chat.remove_member", { room_id: room.id, principal_id: ownId });
			onLeft();
		});

	const memberIds = new Set((members ?? []).map((member) => member.principal_id));
	const candidates = (principals ?? []).filter((principal) => !memberIds.has(principal.id));

	return (
		<Dialog title={`Members of ${roomTitle(room)}`} onClose={onClose}>
			{!fixed && room.role !== null && (
				<form className="chat-browse-search" onSubmit={add} noValidate>
					<label htmlFor={personId} className="visually-hidden">
						Person or agent to add
					</label>
					<Select
						id={personId}
						value={principalId}
						options={candidates.map(principalOption)}
						placeholder="Add a person or an agent…"
						onChange={setPrincipalId}
						disabled={busy || principals === null}
					/>
					<button type="submit" className="button button-primary" disabled={busy || !principalId}>
						Add
					</button>
				</form>
			)}
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<div className="dialog-body chat-dialog-scroll">
				{members === null && !error && (
					<p className="list-state" role="status">
						<span className="spinner" aria-hidden="true" />
						Loading…
					</p>
				)}
				<ul className="chat-rows">
					{(members ?? []).map((member) => (
						<li key={member.principal_id} className="chat-row">
							<span className="avatar avatar-small" aria-hidden="true">
								{initials(member.display_name)}
							</span>
							<span className="chat-row-text">
								<span className="chat-row-name">
									<strong>
										{member.display_name}
										{member.principal_id === ownId && " (you)"}
									</strong>
									{member.kind === "agent" && <span className="kind kind-agent">agent</span>}
								</span>
								<Presence id={member.principal_id} agent={member.kind === "agent"} />
								{member.role === "owner" && <span className="muted">Owner of the room</span>}
							</span>
							{!fixed && room.role === "owner" && member.principal_id !== ownId && (
								<button
									type="button"
									className="button button-small"
									disabled={busy}
									aria-label={`Remove ${member.display_name} from the room`}
									onClick={() => void remove(member)}
								>
									Remove
								</button>
							)}
						</li>
					))}
				</ul>
			</div>
			<div className="dialog-actions">
				{!fixed && room.role !== null && (
					<button
						type="button"
						className="button button-danger-outline chat-leave"
						disabled={busy}
						onClick={() => void leave()}
					>
						Leave the room
					</button>
				)}
				<button type="button" className="button" onClick={onClose}>
					Close
				</button>
			</div>
		</Dialog>
	);
}

const ROOM_DETAILS_RECHECK_MS = 5000;

interface ConfirmedRoomDetails {
	details: ChatRoom;
	checked: ChatRoom;
}

interface RoomDetailsCheck {
	room: ChatRoom;
	startedAt: number;
}

function sameDetails(first: ChatRoom, second: ChatRoom): boolean {
	return first.name === second.name && first.topic === second.topic;
}

/** Read the room when its list disagrees with a write. A list can still have the old name or topic. */
function useConfirmedRoomDetails(room: ChatRoom, mounted: RefObject<boolean>, session: number) {
	const [confirmed, setConfirmed] = useState<ConfirmedRoomDetails | null>(null);
	const checking = useRef(false);
	const [lastCheck, setLastCheck] = useState<RoomDetailsCheck | null>(null);

	const finish = useEffectEvent((base: ConfirmedRoomDetails, check: RoomDetailsCheck, answer?: ChatRoom) => {
		checking.current = false;
		if (!mounted.current || accountChangeCount() !== session) return;
		// A new local save takes priority. Ignore an answer for a conflict that no longer shows.
		const details = answer && sameDetails(check.room, room) ? answer : base.details;
		setConfirmed((current) => (current === base ? { details, checked: check.room } : current));
		setLastCheck(check);
	});

	useEffect(() => {
		if (checking.current || !confirmed || confirmed.checked === room || sameDetails(confirmed.details, room)) return;
		// During a read, React keeps the latest room prop. When the read ends, check only that snapshot.
		const read = () => {
			if (checking.current || !mounted.current || accountChangeCount() !== session) return;
			checking.current = true;
			const check = { room, startedAt: performance.now() };
			void api.call("chat.get_room", { room_id: room.id }).then(
				({ room: answer }) => finish(confirmed, check, answer),
				() => finish(confirmed, check),
			);
		};
		// A real rename can restore an old name. Space the reads for consecutive snapshots with the same details.
		const delay =
			lastCheck && sameDetails(lastCheck.room, room)
				? lastCheck.startedAt + ROOM_DETAILS_RECHECK_MS - performance.now()
				: 0;
		if (delay <= 0) {
			read();
			return;
		}
		const timer = window.setTimeout(read, delay);
		return () => window.clearTimeout(timer);
	}, [lastCheck, confirmed, mounted, room, session]);

	return {
		saved: confirmed?.details ?? room,
		confirm(details: ChatRoom) {
			setLastCheck(null);
			setConfirmed({ details, checked: room });
		},
	};
}

/** Each member selects personal notifications. An owner can also edit a named room. */
export function RoomSettingsDialog({
	room,
	members = [],
	postAllowedIds = [],
	sections = [],
	onClose,
	onDetailsSaved,
	onDeleted,
}: {
	room: ChatRoom;
	members?: readonly ChatMember[];
	postAllowedIds?: readonly string[];
	sections?: readonly ChatSection[];
	onClose(): void;
	onDetailsSaved(): void;
	onDeleted?: () => void;
}) {
	const canEdit = room.kind !== "dm" && room.kind !== "group_dm" && room.role === "owner";
	const [details, setDetails] = useState<{ initial: ChatRoom; name: string; topic: string } | null>(null);
	const [session] = useState(accountChangeCount);
	const mounted = useRef(false);
	useLayoutEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const { saved, confirm } = useConfirmedRoomDetails(room, mounted, session);
	const { data, loading } = useNotificationSettings();
	const [level, setLevel] = useState<RoomNotificationChoice>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const nameInput = useRef<HTMLInputElement>(null);
	const nameId = useId();
	const topicId = useId();
	const sectionId = useId();
	const toast = useToast();
	const savedLevel = data?.settings.room_levels[room.id] ?? "default";
	const selected = level ?? savedLevel;
	const levelChanged = data !== null && selected !== savedLevel;
	// The room stores a single-line topic. Preserve words pasted across lines.
	const topic = details?.topic.replace(/[\r\n\t]+/g, " ").trim();
	const changes = {
		...(canEdit && details && details.name.trim() !== details.initial.name ? { name: details.name.trim() } : {}),
		...(canEdit && details && topic !== details.initial.topic ? { topic } : {}),
	};
	const detailsChanged = Object.keys(changes).length > 0;
	const dirty = detailsChanged || levelChanged;
	const editing = canEdit && details !== null;
	useEffect(() => {
		if (editing) nameInput.current?.focus();
	}, [editing]);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const current = () => mounted.current && accountChangeCount() === session;
		if (!current() || busy || !dirty) return;
		if (editing && !details.name.trim()) {
			setError("Enter a name.");
			nameInput.current?.focus();
			return;
		}
		setBusy(true);
		setError("");
		let detailsSaved = false;
		try {
			if (detailsChanged) {
				const result = await api.call("chat.update_room", { room_id: room.id, ...changes });
				if (!current()) return;
				confirm(result.room);
				setDetails(null);
				detailsSaved = true;
				onDetailsSaved();
			}
			if (levelChanged) {
				if (!current()) return;
				await api.call("chat.set_room_notification_level", {
					room_id: room.id,
					level: selected === "default" ? null : selected,
				});
			}
			if (!current()) return;
			toast({ message: "Room settings saved." });
			onClose();
		} catch (caught) {
			if (!current()) return;
			const reason = errorMessage(caught);
			setError(detailsSaved ? `Room details saved. Your notification preference did not save. ${reason}` : reason);
			setBusy(false);
		}
	}

	return (
		<Dialog title="Room settings" onClose={() => !busy && onClose()} className="dialog-small room-settings">
			<form onSubmit={submit} noValidate>
				<div className="dialog-body">
					{editing ? (
						<div className="room-detail-fields">
							<div className="field">
								<label htmlFor={nameId} className="field-label">
									Room name
								</label>
								<input
									ref={nameInput}
									id={nameId}
									className="input"
									value={details.name}
									maxLength={CHAT_LIMITS.nameChars}
									autoComplete="off"
									disabled={busy}
									onChange={(event) => setDetails({ ...details, name: event.target.value })}
								/>
							</div>
							<div className="field">
								<label htmlFor={topicId} className="field-label">
									Topic
								</label>
								<textarea
									id={topicId}
									className="input"
									rows={2}
									value={details.topic}
									maxLength={CHAT_LIMITS.topicChars}
									disabled={busy}
									onChange={(event) => setDetails({ ...details, topic: event.target.value })}
								/>
							</div>
						</div>
					) : (
						<div className="room-detail-summary">
							<Icon name={room.kind === "dm" ? "user" : room.kind === "private" ? "lock" : "hash"} size={18} />
							<div className="room-detail-text">
								<strong>{room.kind === "dm" ? roomTitle(room) : saved.name}</strong>
								{saved.topic && <p className="room-setting-hint">{saved.topic}</p>}
							</div>
							{canEdit && (
								<button
									type="button"
									className="button button-ghost button-small"
									aria-label="Edit room details"
									disabled={busy}
									onClick={() => setDetails({ initial: saved, name: saved.name ?? "", topic: saved.topic })}
								>
									Edit
								</button>
							)}
						</div>
					)}
					<section className="room-setting-notifications" aria-labelledby={sectionId}>
						<h3 id={sectionId}>
							<Icon name="bell" size={18} /> Notifications
						</h3>
						<p className="room-setting-hint">Your preference for this room.</p>
						{data ? (
							<RoomNotificationChoices
								defaultLevel={data.settings.default_level}
								value={selected}
								disabled={busy}
								onChange={(next) => {
									setError("");
									setLevel(next);
								}}
							/>
						) : (
							loading
						)}
					</section>
					<RoomAdvancedSettings
						room={saved}
						members={members}
						postAllowedIds={postAllowedIds}
						sections={sections}
						onChanged={onDetailsSaved}
						onDeleted={() => {
							onDeleted?.();
							onClose();
						}}
					/>
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<div className="dialog-actions">
					<button type="button" className="button button-ghost" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" className="button button-primary" disabled={busy || !dirty}>
						{busy ? "Saving…" : "Save changes"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}
