import { CHAT_LIMITS, type ChatMember, type ChatRoom, type Principal } from "@soldock/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { initials, plural } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useSession } from "../auth/session.tsx";
import { usePrincipals } from "../drive/data.ts";
import { roomTitle } from "./model.ts";

function principalLabel(principal: Principal): string {
	return `${principal.display_name}${principal.kind === "agent" ? " (agent)" : ""} – ${principal.address}`;
}

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
	const queryId = useId();

	const load = useCallback(async (text: string, cursor: string | null) => {
		try {
			const page = await api.call("chat.list_rooms", {
				view: "public",
				...(text ? { query: text } : {}),
				...(cursor ? { cursor } : {}),
			});
			setState((current) => ({
				status: "ready",
				rooms: cursor ? [...current.rooms, ...page.rooms] : page.rooms,
				nextCursor: page.next_cursor,
				error: null,
			}));
		} catch (caught) {
			setState((current) => ({ ...current, status: "error", error: errorMessage(caught) }));
		}
	}, []);

	useEffect(() => {
		setState({ status: "loading", rooms: [], nextCursor: null, error: null });
		void load(applied, null);
	}, [applied, load]);

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
							<Icon name="hash" />
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
						<button type="button" className="button" onClick={() => void load(applied, state.nextCursor)}>
							Show more rooms
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

/** Opens the direct message room with one person or one agent. */
export function NewDmDialog({ onClose, onOpened }: { onClose: () => void; onOpened: (room: ChatRoom) => void }) {
	const ownId = useSession().whoami.principal.id;
	const principals = usePrincipals();
	const [filter, setFilter] = useState("");
	const [busyId, setBusyId] = useState<string | null>(null);
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

	async function open(principal: Principal) {
		setBusyId(principal.id);
		setError(null);
		try {
			const { room } = await api.call("chat.open_dm", { principal_id: principal.id });
			onOpened(room);
		} catch (caught) {
			setError(errorMessage(caught));
			setBusyId(null);
		}
	}

	return (
		<Dialog title="New direct message" onClose={onClose} className="dialog-small">
			<div className="chat-browse-search">
				<label htmlFor={filterId} className="visually-hidden">
					Name or address
				</label>
				<input
					id={filterId}
					className="input"
					type="search"
					placeholder="Name or address"
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
					{others.map((principal) => (
						<li key={principal.id}>
							<button
								type="button"
								className="chat-row chat-row-button"
								disabled={busyId !== null}
								onClick={() => void open(principal)}
							>
								<span className="avatar avatar-small" aria-hidden="true">
									{initials(principal.display_name)}
								</span>
								<span className="chat-row-text">
									<strong>
										{principal.display_name}
										{principal.kind === "agent" && " (agent)"}
									</strong>
									<span className="muted">{principal.address}</span>
								</span>
							</button>
						</li>
					))}
				</ul>
			</div>
			<div className="dialog-actions">
				<button type="button" className="button" onClick={onClose}>
					Cancel
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
					<select
						id={personId}
						className="input"
						value={principalId}
						onChange={(event) => setPrincipalId(event.target.value)}
						disabled={busy || principals === null}
					>
						<option value="">Add a person or an agent…</option>
						{candidates.map((principal) => (
							<option key={principal.id} value={principal.id}>
								{principalLabel(principal)}
							</option>
						))}
					</select>
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
								<strong>
									{member.display_name}
									{member.principal_id === ownId && " (you)"}
									{member.kind === "agent" && " (agent)"}
								</strong>
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

/** The owner of a room changes its name and its topic. */
export function RoomSettingsDialog({
	room,
	onClose,
	onSaved,
}: {
	room: ChatRoom;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [name, setName] = useState(room.name ?? "");
	const [topic, setTopic] = useState(room.topic);
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
		const changes = {
			...(name.trim() !== room.name ? { name: name.trim() } : {}),
			...(topic.trim() !== room.topic ? { topic: topic.trim() } : {}),
		};
		if (Object.keys(changes).length === 0) {
			onClose();
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.call("chat.update_room", { room_id: room.id, ...changes });
			onSaved();
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog title="Room name and topic" onClose={() => !busy && onClose()} className="dialog-small">
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
							data-autofocus
						/>
					</div>
					<div className="field">
						<label htmlFor={topicId} className="field-label">
							Topic
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
						{busy ? "Saving…" : "Save"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}
