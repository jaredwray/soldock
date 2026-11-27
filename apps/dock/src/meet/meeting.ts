import { DurableObject } from "cloudflare:workers";
import {
	type CallState,
	type EndReason,
	type IceServer,
	type LobbyEntry,
	MEET_LIMITS,
	MEET_SOCKET_CLOSE,
	MEET_SOCKET_PROTOCOL,
	MEET_SOCKET_SUBPROTOCOL,
	type MeetingStatus,
	type MeetSocketMessage,
	type ParticipantState,
	type RosterEntry,
	type SelfState,
} from "@asterra/contracts";
import { type CredentialRef, checkCredentials } from "../identity/index.ts";
import { log, newId } from "../platform/index.ts";
import {
	closeTracks,
	iceServers,
	newSession,
	pullTracks,
	pushTracks,
	type RealtimeConfig,
	RealtimeError,
	realtimeConfig,
	renegotiate,
	revokeTurn,
	sessionState,
} from "./realtime.ts";

// One MeetingDO for each meeting. Its name is the meeting code. It holds the meeting, its participants and the
// map from the tracks of each participant to the tracks of the Realtime SFU. It is the only place that decides
// who sends and receives media: the SFU has no access control, and only this object calls it for a participant.
//
// Each person on the internet can name an object by a code, so the constructor writes nothing. Only `create`
// makes the tables. Each other method returns not_found for an object without a meeting.

type Row = Record<string, SqlStorageValue>;

/** An expected failure, as a value: an error that a Durable Object throws loses its class over RPC. */
export type Refusal = {
	error: {
		code: "invalid" | "not_found" | "forbidden" | "conflict" | "rate_limited" | "unavailable";
		message: string;
	};
};

function refuse(code: Refusal["error"]["code"], message: string): Refusal {
	return { error: { code, message } };
}

const NOT_FOUND = "No meeting has that code.";
const NOT_HOST = "Only the host of the meeting can do this.";
const NOT_ADMITTED = "The host did not admit you to the call.";
const NO_PARTICIPANT = "The meeting has no participant with that id.";
const OVER = "The meeting is over.";
const STALE = "The media session changed. Start the media again.";

/** The header that carries the hash of the participant token from the Worker to the socket of the object. */
export const TOKEN_HASH_HEADER = "x-meet-token-hash";

/** A waiting participant without a socket for this time leaves the lobby. */
const LOBBY_ABSENT_MS = 60_000;
/** An admitted participant without a socket for this time leaves the call. */
const CALL_ABSENT_MS = 120_000;
/** A participant that polled in this time counts as connected without a socket. */
const SEEN_MS = 15_000;
/** The object checks the credentials of its members this often while the call has participants. */
const CREDENTIAL_CHECK_MS = 5 * 60_000;
/** The data of an ended meeting stays for this time, then the object deletes it. */
const ENDED_KEEP_MS = 30 * 24 * 60 * 60_000;
/** An open meeting without activity for this time is deleted. */
const IDLE_KEEP_MS = 90 * 24 * 60 * 60_000;
/** The alarm tries a failed close of a track again after this time. Each later try waits two times longer. */
const CLOSE_RETRY_MS = 5_000;
const CLOSE_RETRY_MAX_MS = 5 * 60_000;
/**
 * After this number of failed tries of a close, the object also reads the session from the SFU. A session that is
 * gone, or a track that is not open there, needs no close.
 */
const CLOSE_CHECK_TRIES = 3;
/** The object writes an error line at most this often while a close is older than this time. */
const CLOSE_LATE_MS = 60 * 60_000;
/** After a credential check that failed, the next check waits this time. */
const CREDENTIAL_RETRY_MS = 60_000;
/** The row of a guest that the host never admitted goes this long after the guest left the lobby. */
const PRUNE_AFTER_MS = 10 * 60_000;
/** The row of each other guest goes this long after the guest left. Its token is of no use at that time. */
const PRUNE_LEFT_MS = 24 * 60 * 60_000;
/**
 * The mid of a row of `pending_closes` that is not one track: the object reads the session from the SFU, and
 * closes each track there that it has no row for. No real mid has this value.
 */
const SWEEP = "*";
/** The time window of the limits `MEET_LIMITS.guestJoinsPerMinute` and `MEET_LIMITS.memberJoinsPerMinute`. */
const JOIN_WINDOW_MS = 60_000;

const SCHEMA: readonly string[] = [
	"CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
	`CREATE TABLE IF NOT EXISTS meeting (
		id TEXT PRIMARY KEY,
		code TEXT NOT NULL,
		host_id TEXT NOT NULL,
		host_name TEXT NOT NULL,
		title TEXT NOT NULL,
		origin TEXT NOT NULL CHECK (origin IN ('standalone', 'calendar')),
		event_id TEXT,
		status TEXT NOT NULL CHECK (status IN ('open', 'ended', 'cancelled')),
		created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		ended_at INTEGER,
		ended_by TEXT,
		last_activity_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS participants (
		id TEXT PRIMARY KEY,
		token_hash TEXT NOT NULL UNIQUE,
		kind TEXT NOT NULL CHECK (kind IN ('member', 'guest')),
		principal_id TEXT,
		credential_json TEXT,
		display_name TEXT NOT NULL,
		role TEXT NOT NULL CHECK (role IN ('host', 'participant')),
		state TEXT NOT NULL CHECK (state IN ('waiting', 'admitted', 'denied', 'left', 'removed')),
		end_reason TEXT,
		requested_at INTEGER NOT NULL,
		decided_at INTEGER,
		decided_by TEXT,
		joined_at INTEGER,
		left_at INTEGER,
		last_seen_at INTEGER NOT NULL,
		audio_muted INTEGER NOT NULL DEFAULT 0,
		sfu_session_id TEXT,
		session_epoch INTEGER NOT NULL DEFAULT 0,
		awaiting_answer INTEGER NOT NULL DEFAULT 0,
		turn_username TEXT
	)`,
	"CREATE INDEX IF NOT EXISTS participants_state ON participants (state, requested_at)",
	`CREATE TABLE IF NOT EXISTS tracks (
		participant_id TEXT NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('audio', 'video')),
		id TEXT NOT NULL UNIQUE,
		track_name TEXT NOT NULL,
		mid TEXT NOT NULL,
		session_epoch INTEGER NOT NULL,
		PRIMARY KEY (participant_id, kind)
	)`,
	`CREATE TABLE IF NOT EXISTS pulls (
		subscriber_id TEXT NOT NULL,
		mid TEXT NOT NULL,
		track_id TEXT NOT NULL,
		publisher_id TEXT NOT NULL,
		session_epoch INTEGER NOT NULL,
		PRIMARY KEY (subscriber_id, mid)
	)`,
	"CREATE INDEX IF NOT EXISTS pulls_track ON pulls (track_id)",
	"CREATE TABLE IF NOT EXISTS removed_principals (principal_id TEXT PRIMARY KEY)",
	// The tracks that the SFU must close. A row goes only after the SFU confirmed the close, or showed that the
	// track is not open. No time limit deletes a row: the delete of the data of the meeting is the last limit.
	`CREATE TABLE IF NOT EXISTS pending_closes (
		session_id TEXT NOT NULL,
		mid TEXT NOT NULL,
		owner_id TEXT NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_at INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (session_id, mid)
	)`,
];

const SCHEMA_VERSION = 1;

export interface MeetingRecord {
	id: string;
	code: string;
	host_id: string;
	host_name: string;
	title: string;
	origin: "standalone" | "calendar";
	event_id: string | null;
	status: MeetingStatus;
	created_at: number;
	ended_at: number | null;
	waiting: number;
	admitted: number;
}

export interface ParticipantRecord {
	id: string;
	kind: "member" | "guest";
	principal_id: string | null;
	display_name: string;
	role: "host" | "participant";
	state: ParticipantState;
	end_reason: EndReason | null;
	connected: boolean;
	audio: boolean;
	video: boolean;
	requested_at: number;
	joined_at: number | null;
}

export interface CreateMeetingInput {
	id: string;
	code: string;
	hostId: string;
	hostName: string;
	title: string;
	origin: "standalone" | "calendar";
	eventId: string | null;
	createdBy: string;
}

export interface JoinInput {
	tokenHash: string;
	/** A signed-in member, from its session. Null for a guest. */
	member: { principalId: string; displayName: string; credential: CredentialRef } | null;
	/** The name that a guest typed. */
	displayName: string | null;
}

export interface CallInfoRecord {
	code: string;
	title: string;
	host_name: string;
	status: MeetingStatus;
	viewer_is_host: boolean;
}

interface ParticipantRow {
	id: string;
	token_hash: string;
	kind: "member" | "guest";
	principal_id: string | null;
	credential_json: string | null;
	display_name: string;
	role: "host" | "participant";
	state: ParticipantState;
	end_reason: EndReason | null;
	requested_at: number;
	joined_at: number | null;
	last_seen_at: number;
	audio_muted: number;
	sfu_session_id: string | null;
	session_epoch: number;
	awaiting_answer: number;
	turn_username: string | null;
}

interface TrackRow {
	participant_id: string;
	kind: "audio" | "video";
	id: string;
	track_name: string;
	mid: string;
	session_epoch: number;
}

interface SocketState {
	participantId: string;
	openedAt: number;
}

function socketTag(participantId: string): string {
	return `p:${participantId}`;
}

function isLive(state: ParticipantState): boolean {
	return state === "waiting" || state === "admitted";
}

export class MeetingDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	/** One chain of SFU calls for each participant: the SFU needs the changes of one session in order. */
	private readonly chains = new Map<string, Promise<unknown>>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
	}

	// --- Storage helpers --------------------------------------------------------------------------

	private exists(): boolean {
		return (
			this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meeting'").toArray().length > 0 &&
			this.sql.exec("SELECT 1 FROM meeting LIMIT 1").toArray().length > 0
		);
	}

	private migrate(): void {
		for (const statement of SCHEMA) this.sql.exec(statement);
		this.sql.exec(
			"INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO NOTHING",
			String(SCHEMA_VERSION),
		);
	}

	private meetingRow(): Row | null {
		return this.sql.exec("SELECT * FROM meeting LIMIT 1").toArray()[0] ?? null;
	}

	private record(row: Row): MeetingRecord {
		const counts = this.sql
			.exec(
				`SELECT SUM(CASE WHEN state = 'waiting' THEN 1 ELSE 0 END) AS waiting,
					SUM(CASE WHEN state = 'admitted' THEN 1 ELSE 0 END) AS admitted FROM participants`,
			)
			.one();
		return {
			id: row.id as string,
			code: row.code as string,
			host_id: row.host_id as string,
			host_name: row.host_name as string,
			title: row.title as string,
			origin: row.origin as MeetingRecord["origin"],
			event_id: (row.event_id as string | null) ?? null,
			status: row.status as MeetingStatus,
			created_at: row.created_at as number,
			ended_at: (row.ended_at as number | null) ?? null,
			waiting: (counts.waiting as number | null) ?? 0,
			admitted: (counts.admitted as number | null) ?? 0,
		};
	}

	private participantRow(where: "id" | "token_hash", value: string): ParticipantRow | null {
		return (
			(this.sql.exec(`SELECT * FROM participants WHERE ${where} = ?`, value).toArray()[0] as unknown as
				| ParticipantRow
				| undefined) ?? null
		);
	}

	private tracksOf(participantId: string): TrackRow[] {
		return this.sql
			.exec("SELECT * FROM tracks WHERE participant_id = ? ORDER BY kind", participantId)
			.toArray() as unknown as TrackRow[];
	}

	private connected(row: ParticipantRow, now: number): boolean {
		return this.ctx.getWebSockets(socketTag(row.id)).length > 0 || row.last_seen_at > now - SEEN_MS;
	}

	private participantRecord(row: ParticipantRow, now = Date.now()): ParticipantRecord {
		const tracks = this.tracksOf(row.id);
		return {
			id: row.id,
			kind: row.kind,
			principal_id: row.principal_id,
			display_name: row.display_name,
			role: row.role,
			state: row.state,
			end_reason: row.end_reason,
			connected: isLive(row.state) && this.connected(row, now),
			audio: tracks.some((track) => track.kind === "audio") && row.audio_muted === 0,
			video: tracks.some((track) => track.kind === "video"),
			requested_at: row.requested_at,
			joined_at: row.joined_at,
		};
	}

	/**
	 * Records activity: a decision of the host, or a media session of an admitted participant. A join or a leave
	 * is not activity, so a person with the link cannot keep an idle meeting open.
	 */
	private touchActivity(now: number): void {
		this.sql.exec("UPDATE meeting SET last_activity_at = ?", now);
	}

	/** The participant of a token. A token that ended its life counts as a participant that left. */
	private byToken(tokenHash: string): ParticipantRow | Refusal {
		if (!this.exists()) return refuse("not_found", NOT_FOUND);
		const row = this.participantRow("token_hash", tokenHash);
		if (!row) return refuse("forbidden", "The meeting does not know this participant token. Join again.");
		// The life of a token ends at its time, also when the alarm is late. The alarm does the same change.
		const now = Date.now();
		if (isLive(row.state) && row.requested_at + MEET_LIMITS.tokenMs <= now) {
			this.sql.exec(
				"UPDATE participants SET state = 'left', end_reason = 'expired', left_at = ? WHERE id = ?",
				now,
				row.id,
			);
			this.endSockets(row.id, "expired");
			// The rows of the media go in this call. The answer does not wait for the SFU.
			this.ctx.waitUntil(this.teardown([row.id]));
			return this.participantRow("id", row.id) as ParticipantRow;
		}
		return row;
	}

	/** The participant of a token that can use media now. */
	private admittedByToken(tokenHash: string): ParticipantRow | Refusal {
		const row = this.byToken(tokenHash);
		if ("error" in row) return row;
		if ((this.meetingRow() as Row).status !== "open") return refuse("forbidden", OVER);
		if (row.state !== "admitted") return refuse("forbidden", NOT_ADMITTED);
		return row;
	}

	private hostCheck(actorId: string): { meeting: Row } | Refusal {
		if (!this.exists()) return refuse("not_found", NOT_FOUND);
		const meeting = this.meetingRow() as Row;
		if (meeting.host_id !== actorId) return refuse("forbidden", NOT_HOST);
		return { meeting };
	}

	// --- Management (the operations) -----------------------------------------------------------------

	/** Makes the meeting. A second call for a code that has a meeting gives conflict. */
	async create(input: CreateMeetingInput): Promise<MeetingRecord | Refusal> {
		if (this.exists()) return refuse("conflict", "A meeting with that code exists.");
		this.migrate();
		const now = Date.now();
		this.sql.exec(
			`INSERT INTO meeting (id, code, host_id, host_name, title, origin, event_id, status, created_by, created_at,
				last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
			input.id,
			input.code,
			input.hostId,
			input.hostName,
			input.title,
			input.origin,
			input.eventId,
			input.createdBy,
			now,
			now,
		);
		await this.schedule();
		return this.record(this.meetingRow() as Row);
	}

	async get(actorId: string): Promise<MeetingRecord | Refusal> {
		const checked = this.hostCheck(actorId);
		if ("error" in checked) return checked;
		const { meeting } = checked;
		return this.record(meeting);
	}

	async listParticipants(actorId: string): Promise<ParticipantRecord[] | Refusal> {
		const checked = this.hostCheck(actorId);
		if ("error" in checked) return checked;
		const now = Date.now();
		return (
			this.sql
				.exec("SELECT * FROM participants WHERE state IN ('waiting', 'admitted') ORDER BY requested_at, id")
				.toArray() as unknown as ParticipantRow[]
		).map((row) => this.participantRecord(row, now));
	}

	/** Ends the meeting for each participant. A second call changes nothing. */
	async end(actorId: string): Promise<{ meeting: MeetingRecord; changed: boolean } | Refusal> {
		const checked = this.hostCheck(actorId);
		if ("error" in checked) return checked;
		const { meeting } = checked;
		if (meeting.status !== "open") return { meeting: this.record(meeting), changed: false };
		await this.close("ended", actorId);
		return { meeting: this.record(this.meetingRow() as Row), changed: true };
	}

	/** Admits, refuses or removes a participant. */
	async decide(
		actorId: string,
		participantId: string,
		decision: "admit" | "deny" | "remove",
	): Promise<{ participant: ParticipantRecord; changed: boolean; meetingId: string } | Refusal> {
		const checked = this.hostCheck(actorId);
		if ("error" in checked) return checked;
		const { meeting } = checked;
		const row = this.participantRow("id", participantId);
		if (!row) return refuse("not_found", NO_PARTICIPANT);
		const done = { admit: "admitted", deny: "denied", remove: "removed" } as const;
		const meetingId = meeting.id as string;
		if (row.state === done[decision]) return { participant: this.participantRecord(row), changed: false, meetingId };
		if (meeting.status !== "open") return refuse("conflict", OVER);
		const now = Date.now();
		if (decision === "admit" || decision === "deny") {
			if (row.state !== "waiting") return refuse("conflict", "The participant is not in the lobby.");
			if (decision === "admit") {
				const admitted = this.sql.exec("SELECT COUNT(*) AS n FROM participants WHERE state = 'admitted'").one()
					.n as number;
				if (admitted >= MEET_LIMITS.admitted) {
					return refuse("conflict", `The call is full: it has ${MEET_LIMITS.admitted} participants.`);
				}
				// A member that the host admits again is no longer refused at the door.
				if (row.principal_id) this.sql.exec("DELETE FROM removed_principals WHERE principal_id = ?", row.principal_id);
				this.sql.exec(
					"UPDATE participants SET state = 'admitted', decided_at = ?, decided_by = ? WHERE id = ?",
					now,
					actorId,
					row.id,
				);
			} else {
				this.sql.exec(
					`UPDATE participants SET state = 'denied', end_reason = 'denied', decided_at = ?, decided_by = ?, left_at = ?
					WHERE id = ?`,
					now,
					actorId,
					now,
					row.id,
				);
			}
			this.touchActivity(now);
			this.broadcast();
			if (decision === "deny") this.endSockets(row.id, "denied");
			return {
				participant: this.participantRecord(this.participantRow("id", row.id) as ParticipantRow),
				changed: true,
				meetingId,
			};
		}
		// remove
		if (row.state !== "admitted") return refuse("conflict", "The participant is not in the call. Refuse it instead.");
		if (row.role === "host") return refuse("conflict", "The host cannot remove itself. End the meeting instead.");
		this.sql.exec(
			`UPDATE participants SET state = 'removed', end_reason = 'removed', decided_at = ?, decided_by = ?, left_at = ?
			WHERE id = ?`,
			now,
			actorId,
			now,
			row.id,
		);
		if (row.principal_id) {
			this.sql.exec("INSERT OR IGNORE INTO removed_principals (principal_id) VALUES (?)", row.principal_id);
		}
		this.touchActivity(now);
		this.broadcast();
		this.endSockets(row.id, "removed");
		await this.teardown([row.id]);
		return {
			participant: this.participantRecord(this.participantRow("id", row.id) as ParticipantRow),
			changed: true,
			meetingId,
		};
	}

	// --- The call (the routes of a browser) -------------------------------------------------------

	/** What each person with the link can read. */
	async info(viewerId: string | null): Promise<CallInfoRecord | Refusal> {
		if (!this.exists()) return refuse("not_found", NOT_FOUND);
		const meeting = this.meetingRow() as Row;
		return {
			code: meeting.code as string,
			title: meeting.title as string,
			host_name: meeting.host_name as string,
			status: meeting.status as MeetingStatus,
			viewer_is_host: viewerId !== null && viewerId === meeting.host_id,
		};
	}

	/**
	 * Adds a participant with a new token. The host joins the call at once, and so does a member of the
	 * organization that the host did not remove. A guest waits in the lobby. A member has one row: a new join closes
	 * its earlier row, and deletes each closed row of the member that is older than one minute. A join is not
	 * activity: it does not make the life of an idle meeting longer.
	 */
	async join(input: JoinInput): Promise<SelfState | Refusal> {
		if (!this.exists()) return refuse("not_found", NOT_FOUND);
		const meeting = this.meetingRow() as Row;
		if (meeting.status === "cancelled") return refuse("conflict", "The meeting was cancelled.");
		if (meeting.status !== "open") return refuse("conflict", "The meeting ended.");
		const now = Date.now();
		// The limits of the lobby and of the rows are for guests only. The host and each member get a row, so a
		// person with the link cannot lock them out. A member has a limit of its own join requests only.
		if (input.member) {
			const principalId = input.member.principalId;
			// A closed row of the member goes one minute after its end. Each row of the last minute stays: these
			// rows are the count for the limit. So a member has at most `memberJoinsPerMinute` + 1 rows.
			this.sql.exec(
				`DELETE FROM participants WHERE principal_id = ? AND state IN ('denied', 'left', 'removed')
					AND left_at <= ?`,
				principalId,
				now - JOIN_WINDOW_MS,
			);
			const recent = this.sql
				.exec(
					"SELECT COUNT(*) AS n FROM participants WHERE principal_id = ? AND requested_at > ?",
					principalId,
					now - JOIN_WINDOW_MS,
				)
				.one().n as number;
			if (recent >= MEET_LIMITS.memberJoinsPerMinute) {
				return refuse("rate_limited", "You asked to join this meeting too many times. Try again in one minute.");
			}
		} else {
			this.sql.exec(
				`DELETE FROM participants WHERE kind = 'guest' AND state IN ('denied', 'left', 'removed') AND (left_at <= ?
					OR (left_at <= ? AND (state = 'denied' OR (state = 'left' AND decided_at IS NULL))))`,
				now - PRUNE_LEFT_MS,
				now - PRUNE_AFTER_MS,
			);
			const guests = this.sql
				.exec(
					`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN requested_at > ? THEN 1 ELSE 0 END), 0) AS recent
						FROM participants WHERE kind = 'guest'`,
					now - JOIN_WINDOW_MS,
				)
				.one();
			if ((guests.recent as number) >= MEET_LIMITS.guestJoinsPerMinute) {
				return refuse("rate_limited", "Too many guests asked to join this meeting. Try again in one minute.");
			}
			if ((guests.n as number) >= MEET_LIMITS.participantRows) {
				return refuse("rate_limited", "The meeting has too many join requests. Ask the host for a new link.");
			}
		}
		const id = newId("par");
		let role: "host" | "participant" = "participant";
		let state: ParticipantState = "waiting";
		const earlier: string[] = [];
		if (input.member) {
			const principalId = input.member.principalId;
			if (principalId === meeting.host_id) {
				role = "host";
				state = "admitted";
			} else {
				const removed =
					this.sql.exec("SELECT 1 FROM removed_principals WHERE principal_id = ?", principalId).toArray().length > 0;
				const admitted = this.sql.exec("SELECT COUNT(*) AS n FROM participants WHERE state = 'admitted'").one()
					.n as number;
				state = !removed && admitted < MEET_LIMITS.admitted ? "admitted" : "waiting";
			}
			for (const row of this.sql
				.exec("SELECT id FROM participants WHERE principal_id = ? AND state IN ('waiting', 'admitted')", principalId)
				.toArray()) {
				earlier.push(row.id as string);
			}
		}
		if (state === "waiting") {
			const waiting = this.sql.exec("SELECT COUNT(*) AS n FROM participants WHERE state = 'waiting'").one().n as number;
			if (waiting >= MEET_LIMITS.waiting) {
				return refuse("rate_limited", "The lobby is full. Try again later.");
			}
		}
		const displayName = input.member?.displayName ?? input.displayName;
		if (!displayName) return refuse("invalid", "Enter your name.");
		// A new join of a member replaces its earlier rows, also in a different tab.
		for (const old of earlier) {
			this.sql.exec("UPDATE participants SET state = 'left', end_reason = 'left', left_at = ? WHERE id = ?", now, old);
			this.endSockets(old, "left");
		}
		this.sql.exec(
			`INSERT INTO participants (id, token_hash, kind, principal_id, credential_json, display_name, role, state,
				requested_at, last_seen_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			input.tokenHash,
			input.member ? "member" : "guest",
			input.member?.principalId ?? null,
			input.member ? JSON.stringify(input.member.credential) : null,
			displayName,
			role,
			state,
			now,
			now,
			state === "admitted" ? now : null,
		);
		this.broadcast();
		// The rows of the earlier join are gone now. The answer does not wait for the SFU.
		if (earlier.length > 0) this.ctx.waitUntil(this.teardown(earlier));
		await this.schedule();
		return this.self(this.participantRow("id", id) as ParticipantRow);
	}

	private self(row: ParticipantRow): SelfState {
		return {
			id: row.id,
			kind: row.kind,
			role: row.role,
			state: row.state,
			end_reason: row.end_reason,
			display_name: row.display_name,
		};
	}

	/** The state of the meeting for the participant of a token. A poll counts as a sign of life. */
	async state(tokenHash: string): Promise<CallState | Refusal> {
		const row = this.byToken(tokenHash);
		if ("error" in row) return row;
		const now = Date.now();
		if (isLive(row.state)) this.sql.exec("UPDATE participants SET last_seen_at = ? WHERE id = ?", now, row.id);
		return this.snapshot(this.participantRow("id", row.id) as ParticipantRow, now);
	}

	async leave(tokenHash: string): Promise<{ ok: true } | Refusal> {
		const row = this.byToken(tokenHash);
		if ("error" in row) return row;
		if (!isLive(row.state)) return { ok: true };
		const now = Date.now();
		this.sql.exec("UPDATE participants SET state = 'left', end_reason = 'left', left_at = ? WHERE id = ?", now, row.id);
		this.broadcast();
		this.endSockets(row.id, "left");
		await this.teardown([row.id]);
		return { ok: true };
	}

	private snapshot(row: ParticipantRow, now: number): CallState {
		const meeting = this.meetingRow() as Row;
		const version = Number(
			this.sql.exec("SELECT value FROM meta WHERE key = 'state_version'").toArray()[0]?.value ?? "0",
		);
		const state: CallState = {
			version,
			meeting: {
				code: meeting.code as string,
				title: meeting.title as string,
				host_name: meeting.host_name as string,
				status: meeting.status as MeetingStatus,
			},
			self: this.self(row),
		};
		if (row.state === "admitted" && meeting.status === "open") {
			const rows = this.sql
				.exec("SELECT * FROM participants WHERE state = 'admitted' ORDER BY requested_at, id")
				.toArray() as unknown as ParticipantRow[];
			state.participants = rows.map(
				(entry): RosterEntry => ({
					id: entry.id,
					display_name: entry.display_name,
					kind: entry.kind,
					role: entry.role,
					connected: this.connected(entry, now),
					audio_muted: entry.audio_muted === 1,
					tracks: this.tracksOf(entry.id).map((track) => ({ id: track.id, kind: track.kind })),
				}),
			);
			if (row.role === "host") {
				state.lobby = (
					this.sql
						.exec("SELECT * FROM participants WHERE state = 'waiting' ORDER BY requested_at, id")
						.toArray() as unknown as ParticipantRow[]
				).map(
					(entry): LobbyEntry => ({
						id: entry.id,
						display_name: entry.display_name,
						kind: entry.kind,
						requested_at: new Date(entry.requested_at).toISOString(),
					}),
				);
			}
		}
		return state;
	}

	// --- Media ---------------------------------------------------------------------------------------

	private config(): RealtimeConfig | Refusal {
		return realtimeConfig(this.env) ?? refuse("unavailable", "Meet is not set up. See docs/self-hosting.md#meet.");
	}

	/** Runs `run` after the earlier SFU calls of the participant. */
	private enqueue<T>(participantId: string, run: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(participantId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(run);
		this.chains.set(
			participantId,
			next.catch(() => undefined),
		);
		return next;
	}

	private failure(error: unknown): Refusal {
		if (error instanceof RealtimeError) {
			log("warn", "meet: the media service refused a call", { status: error.status, code: error.code });
			return refuse("unavailable", "The media service did not accept the request. Try again.");
		}
		throw error;
	}

	/** A new SFU session for an admitted participant. It replaces each earlier session of the participant. */
	async mediaSession(tokenHash: string): Promise<{ session: number; ice_servers: IceServer[] } | Refusal> {
		const first = this.admittedByToken(tokenHash);
		if ("error" in first) return first;
		const config = this.config();
		if ("error" in config) return config;
		return this.enqueue(first.id, async () => {
			const before = this.admittedByToken(tokenHash);
			if ("error" in before) return before;
			let sessionId: string;
			let ice: { servers: IceServer[]; username: string | null };
			try {
				[sessionId, ice] = await Promise.all([newSession(config), iceServers(config)]);
			} catch (error) {
				return this.failure(error);
			}
			const after = this.admittedByToken(tokenHash);
			if ("error" in after) {
				if (ice.username) await revokeTurn(config, ice.username);
				return after;
			}
			const now = Date.now();
			const epoch = after.session_epoch + 1;
			const oldTurn = after.turn_username;
			// The SFU has no call that ends a session, and the old connection of the browser can stay open. So the
			// object closes each track and each pull of the old session, and each pull of its tracks by the others.
			this.dropMedia(after.id);
			this.sql.exec(
				`UPDATE participants SET sfu_session_id = ?, session_epoch = ?, awaiting_answer = 0, turn_username = ?,
					joined_at = COALESCE(joined_at, ?), last_seen_at = ? WHERE id = ?`,
				sessionId,
				epoch,
				ice.username,
				now,
				now,
				after.id,
			);
			this.touchActivity(now);
			this.broadcast();
			this.kick();
			if (oldTurn) this.ctx.waitUntil(revokeTurn(config, oldTurn));
			return { session: epoch, ice_servers: ice.servers };
		});
	}

	/**
	 * Records tracks of one session that the SFU must close. `ownerId` is the participant of the session: the close
	 * runs on its chain. The caller deletes the rows of the tracks in the same synchronous block, so a track is in
	 * `tracks` or `pulls`, or it is in `pending_closes`, also after a restart of the object.
	 */
	private queueCloses(ownerId: string, sessionId: string | null, mids: readonly string[]): void {
		if (!sessionId) return;
		const now = Date.now();
		for (const mid of mids) {
			this.sql.exec(
				// A second request for the same mid starts its tries again: the caller wants the close now.
				`INSERT INTO pending_closes (session_id, mid, owner_id, attempts, next_at, created_at)
					VALUES (?, ?, ?, 0, ?, ?)
					ON CONFLICT (session_id, mid) DO UPDATE SET attempts = 0, next_at = excluded.next_at`,
				sessionId,
				mid,
				ownerId,
				now + CLOSE_RETRY_MS,
				now,
			);
		}
	}

	/**
	 * Records the close of each pull of a track, or of each track of a publisher. Each pull goes with the SFU
	 * session of its subscriber at this moment, so a later new session of the subscriber cannot get the close.
	 */
	private queuePullCloses(column: "track_id" | "publisher_id", value: string): void {
		const pulls = this.sql
			.exec(
				`SELECT p.subscriber_id, p.mid, s.sfu_session_id FROM pulls p
					JOIN participants s ON s.id = p.subscriber_id WHERE p.${column} = ?`,
				value,
			)
			.toArray();
		for (const pull of pulls) {
			this.queueCloses(pull.subscriber_id as string, pull.sfu_session_id as string | null, [pull.mid as string]);
		}
	}

	/**
	 * Deletes the tracks and the pulls of a participant from the tables, and records their close on the SFU: the
	 * tracks and the pulls on the session of the participant, and the pulls of its tracks on the sessions of the
	 * others.
	 */
	private dropMedia(participantId: string): void {
		const row = this.participantRow("id", participantId);
		if (!row) return;
		const own = [
			...this.tracksOf(participantId).map((track) => track.mid),
			...this.sql
				.exec("SELECT mid FROM pulls WHERE subscriber_id = ?", participantId)
				.toArray()
				.map((pull) => pull.mid as string),
		];
		// The session ends here. A push or a pull that got no answer can have a track without a row: the SWEEP row
		// makes the object read the session from the SFU and close what it finds.
		this.queueCloses(participantId, row.sfu_session_id, [...own, SWEEP]);
		this.queuePullCloses("publisher_id", participantId);
		this.sql.exec("DELETE FROM pulls WHERE publisher_id = ? OR subscriber_id = ?", participantId, participantId);
		this.sql.exec("DELETE FROM tracks WHERE participant_id = ?", participantId);
	}

	/** The mids of the tracks and the pulls that a participant has rows for on this SFU session. */
	private liveMids(ownerId: string, sessionId: string): Set<string> {
		const owner = this.participantRow("id", ownerId);
		if (owner?.sfu_session_id !== sessionId) return new Set();
		return new Set([
			...this.tracksOf(ownerId).map((track) => track.mid),
			...this.sql
				.exec("SELECT mid FROM pulls WHERE subscriber_id = ?", ownerId)
				.toArray()
				.map((pull) => pull.mid as string),
		]);
	}

	private retryClose(sessionId: string, mid: string): void {
		this.sql.exec(
			`UPDATE pending_closes SET next_at = ? + MIN(?, ? * (1 << MIN(attempts, 10))), attempts = attempts + 1
				WHERE session_id = ? AND mid = ?`,
			Date.now(),
			CLOSE_RETRY_MAX_MS,
			CLOSE_RETRY_MS,
			sessionId,
			mid,
		);
	}

	private dueCloses(sessionId: string): string[] {
		return this.sql
			.exec(
				"SELECT mid FROM pending_closes WHERE session_id = ? AND (attempts = 0 OR next_at <= ?)",
				sessionId,
				Date.now(),
			)
			.toArray()
			.map((row) => row.mid as string);
	}

	/**
	 * The recorded closes of a session that failed `CLOSE_CHECK_TRIES` times: the object reads the session from the
	 * SFU, and deletes each row of a track that is not open there. Returns false when the meeting has no data now.
	 */
	private async checkStuckCloses(config: RealtimeConfig, sessionId: string): Promise<boolean> {
		const stuck = this.sql
			.exec(
				"SELECT mid FROM pending_closes WHERE session_id = ? AND mid != ? AND attempts >= ? AND next_at <= ?",
				sessionId,
				SWEEP,
				CLOSE_CHECK_TRIES,
				Date.now(),
			)
			.toArray()
			.map((row) => row.mid as string);
		if (stuck.length === 0) return true;
		let onSfu: string[] | null;
		try {
			onSfu = await sessionState(config, sessionId);
		} catch {
			// The close call that follows writes the log line of a media service that does not answer.
			return this.exists();
		}
		if (!this.exists()) return false;
		const open = new Set(onSfu ?? []);
		for (const mid of stuck) {
			if (!open.has(mid)) {
				this.sql.exec(
					"DELETE FROM pending_closes WHERE session_id = ? AND mid = ? AND attempts >= ?",
					sessionId,
					mid,
					CLOSE_CHECK_TRIES,
				);
			}
		}
		return true;
	}

	/**
	 * Closes the recorded tracks of one session on the SFU. It runs on the chain of the owner of the session. A row
	 * goes when the SFU confirmed the close, or showed that the track is not open. A different row waits for the
	 * alarm: each time two times longer, then each `CLOSE_RETRY_MAX_MS` while the meeting has data.
	 */
	private async closeSession(ownerId: string, sessionId: string): Promise<void> {
		const config = realtimeConfig(this.env);
		const due = this.dueCloses(sessionId);
		if (due.length === 0) return;
		if (!config) {
			for (const mid of due) this.retryClose(sessionId, mid);
			return;
		}
		if (due.includes(SWEEP)) {
			let onSfu: string[] | null | undefined;
			try {
				onSfu = await sessionState(config, sessionId);
			} catch (error) {
				log("warn", "meet: the media service did not give the state of a session", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			// The alarm can delete the data of an old meeting while the SFU call runs.
			if (!this.exists()) return;
			if (onSfu === undefined) {
				this.retryClose(sessionId, SWEEP);
			} else {
				const live = this.liveMids(ownerId, sessionId);
				this.queueCloses(
					ownerId,
					sessionId,
					(onSfu ?? []).filter((mid) => !live.has(mid)),
				);
				this.sql.exec("DELETE FROM pending_closes WHERE session_id = ? AND mid = ?", sessionId, SWEEP);
			}
		}
		if (!(await this.checkStuckCloses(config, sessionId))) return;
		// A mid with a row in `tracks` or `pulls` is in use again. Its close is not wanted now.
		const live = this.liveMids(ownerId, sessionId);
		const mids: string[] = [];
		for (const mid of this.dueCloses(sessionId)) {
			if (mid === SWEEP) continue;
			if (live.has(mid)) this.sql.exec("DELETE FROM pending_closes WHERE session_id = ? AND mid = ?", sessionId, mid);
			else mids.push(mid);
		}
		if (mids.length === 0) return;
		const closed = await closeTracks(config, sessionId, mids);
		if (!this.exists()) return;
		for (const mid of mids) {
			if (closed.has(mid)) {
				this.sql.exec("DELETE FROM pending_closes WHERE session_id = ? AND mid = ?", sessionId, mid);
			} else {
				this.retryClose(sessionId, mid);
			}
		}
	}

	/**
	 * Writes an error line for the closes that the SFU did not confirm in `CLOSE_LATE_MS`. The rows stay: a
	 * participant that the host removed can still have media, so the object does not stop its tries.
	 */
	private reportLateCloses(now: number): void {
		const late = this.sql
			.exec("SELECT COUNT(*) AS n FROM pending_closes WHERE created_at <= ?", now - CLOSE_LATE_MS)
			.one().n as number;
		if (late === 0) return;
		const reported = Number(
			this.sql.exec("SELECT value FROM meta WHERE key = 'closes_reported_at'").toArray()[0]?.value ?? 0,
		);
		if (reported + CLOSE_LATE_MS > now) return;
		this.sql.exec(
			"INSERT INTO meta (key, value) VALUES ('closes_reported_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
			String(now),
		);
		log("error", "meet: the media service did not confirm the close of tracks", { count: late });
	}

	/**
	 * Sends the recorded closes to the SFU: the new ones, or for the alarm (`due`) the ones whose time came. The
	 * alarm is set before the first SFU call, so a close that fails, or an object that stops, gets a later try.
	 */
	private async flushCloses(due: boolean): Promise<void> {
		if (!this.exists()) return;
		const now = Date.now();
		if (due) this.reportLateCloses(now);
		const sessions = (
			due
				? this.sql.exec("SELECT DISTINCT session_id, owner_id FROM pending_closes WHERE next_at <= ?", now)
				: this.sql.exec("SELECT DISTINCT session_id, owner_id FROM pending_closes WHERE attempts = 0")
		).toArray();
		const scheduled = this.schedule();
		const jobs = sessions.map((row) =>
			this.enqueue(row.owner_id as string, () => this.closeSession(row.owner_id as string, row.session_id as string)),
		);
		await Promise.all([scheduled, ...jobs]);
		await this.schedule();
	}

	/**
	 * Starts the new closes without a wait for them. Use it on the chain of a participant: a wait there for a
	 * close on the same chain never ends.
	 */
	private kick(): void {
		this.ctx.waitUntil(
			this.flushCloses(false).catch((error: unknown) => {
				log("warn", "meet: a close of tracks failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}),
		);
	}

	async publish(
		tokenHash: string,
		input: { session: number; offer: string; tracks: { mid: string; kind: "audio" | "video" }[] },
	): Promise<{ answer: string; tracks: { id: string; kind: "audio" | "video"; mid: string }[] } | Refusal> {
		const first = this.admittedByToken(tokenHash);
		if ("error" in first) return first;
		const config = this.config();
		if ("error" in config) return config;
		const kinds = new Set(input.tracks.map((track) => track.kind));
		if (kinds.size !== input.tracks.length) return refuse("invalid", "Send at most one audio and one video track.");
		return this.enqueue(first.id, async () => {
			const row = this.admittedByToken(tokenHash);
			if ("error" in row) return row;
			if (row.session_epoch !== input.session || !row.sfu_session_id) return refuse("conflict", STALE);
			if (row.awaiting_answer === 1) return refuse("conflict", "Answer the offer of the last subscribe first.");
			const live = new Set(this.tracksOf(row.id).map((track) => track.kind));
			if (input.tracks.some((track) => live.has(track.kind))) {
				return refuse("conflict", "You send that kind of track already. Stop it first.");
			}
			const planned = input.tracks.map((track) => ({
				...track,
				id: newId("trk"),
				trackName: `${row.id}-${track.kind}-${row.session_epoch}-${crypto.randomUUID().slice(0, 8)}`,
			}));
			let result: Awaited<ReturnType<typeof pushTracks>>;
			try {
				result = await pushTracks(config, row.sfu_session_id, input.offer, planned);
			} catch (error) {
				// Without an answer, the object does not know if the SFU made the tracks. So it closes their mids.
				if (error instanceof RealtimeError && error.status === 0) {
					this.queueCloses(
						row.id,
						row.sfu_session_id,
						planned.map((track) => track.mid),
					);
					this.kick();
				}
				return this.failure(error);
			}
			const after = this.participantRow("id", row.id);
			const made = result.tracks.filter((track) => !track.errorCode && track.mid).map((track) => track.mid as string);
			if (after?.state !== "admitted" || after.session_epoch !== row.session_epoch) {
				this.queueCloses(row.id, row.sfu_session_id, made);
				this.kick();
				return after?.state === "admitted" ? refuse("conflict", STALE) : refuse("forbidden", NOT_ADMITTED);
			}
			const out: { id: string; kind: "audio" | "video"; mid: string }[] = [];
			for (const track of planned) {
				const answer = result.tracks.find((item) => item.trackName === track.trackName);
				if (!answer || answer.errorCode) continue;
				this.sql.exec(
					"INSERT INTO tracks (participant_id, kind, id, track_name, mid, session_epoch) VALUES (?, ?, ?, ?, ?, ?)",
					row.id,
					track.kind,
					track.id,
					track.trackName,
					track.mid,
					row.session_epoch,
				);
				out.push({ id: track.id, kind: track.kind, mid: track.mid });
			}
			this.broadcast();
			return { answer: result.answer, tracks: out };
		});
	}

	async unpublish(
		tokenHash: string,
		input: { session: number; kinds: ("audio" | "video")[] },
	): Promise<{ ok: true } | Refusal> {
		const first = this.admittedByToken(tokenHash);
		if ("error" in first) return first;
		const config = this.config();
		if ("error" in config) return config;
		return this.enqueue(first.id, async () => {
			const row = this.admittedByToken(tokenHash);
			if ("error" in row) return row;
			if (row.session_epoch !== input.session || !row.sfu_session_id) return refuse("conflict", STALE);
			const tracks = this.tracksOf(row.id).filter((track) => input.kinds.includes(track.kind));
			if (tracks.length === 0) return { ok: true } as const;
			for (const track of tracks) {
				this.queuePullCloses("track_id", track.id);
				this.sql.exec("DELETE FROM pulls WHERE track_id = ?", track.id);
				this.sql.exec("DELETE FROM tracks WHERE id = ?", track.id);
			}
			this.queueCloses(
				row.id,
				row.sfu_session_id,
				tracks.map((track) => track.mid),
			);
			this.broadcast();
			this.kick();
			return { ok: true } as const;
		});
	}

	async subscribe(
		tokenHash: string,
		input: { session: number; trackIds: string[] },
	): Promise<{ offer: string | null; tracks: { id: string; mid: string }[]; failed: string[] } | Refusal> {
		const first = this.admittedByToken(tokenHash);
		if ("error" in first) return first;
		const config = this.config();
		if ("error" in config) return config;
		return this.enqueue(first.id, async () => {
			const row = this.admittedByToken(tokenHash);
			if ("error" in row) return row;
			if (row.session_epoch !== input.session || !row.sfu_session_id) return refuse("conflict", STALE);
			if (row.awaiting_answer === 1) return refuse("conflict", "Answer the offer of the last subscribe first.");
			const failed: string[] = [];
			const existing: { id: string; mid: string }[] = [];
			const wanted: { track: TrackRow; sessionId: string }[] = [];
			for (const trackId of new Set(input.trackIds)) {
				const pulled = this.sql
					.exec("SELECT mid FROM pulls WHERE subscriber_id = ? AND track_id = ?", row.id, trackId)
					.toArray()[0];
				if (pulled) {
					existing.push({ id: trackId, mid: pulled.mid as string });
					continue;
				}
				const track = this.sql.exec("SELECT * FROM tracks WHERE id = ?", trackId).toArray()[0] as unknown as
					| TrackRow
					| undefined;
				const publisher = track ? this.participantRow("id", track.participant_id) : null;
				if (
					!track ||
					!publisher ||
					publisher.id === row.id ||
					publisher.state !== "admitted" ||
					!publisher.sfu_session_id ||
					publisher.session_epoch !== track.session_epoch
				) {
					failed.push(trackId);
					continue;
				}
				wanted.push({ track, sessionId: publisher.sfu_session_id });
			}
			if (wanted.length === 0) return { offer: null, tracks: existing, failed };
			let result: Awaited<ReturnType<typeof pullTracks>>;
			try {
				result = await pullTracks(
					config,
					row.sfu_session_id,
					wanted.map((item) => ({ sessionId: item.sessionId, trackName: item.track.track_name })),
				);
			} catch (error) {
				// Without an answer, the SFU can have pulls with mids that the object does not know. The object reads
				// the session and closes each track without a row.
				if (error instanceof RealtimeError && error.status === 0) {
					this.queueCloses(row.id, row.sfu_session_id, [SWEEP]);
					this.kick();
				}
				return this.failure(error);
			}
			const after = this.participantRow("id", row.id);
			const madeMids = result.tracks
				.filter((track) => !track.errorCode && track.mid)
				.map((track) => track.mid as string);
			if (after?.state !== "admitted" || after.session_epoch !== row.session_epoch) {
				this.queueCloses(row.id, row.sfu_session_id, madeMids);
				this.kick();
				return after?.state === "admitted" ? refuse("conflict", STALE) : refuse("forbidden", NOT_ADMITTED);
			}
			const out: { id: string; mid: string }[] = [...existing];
			const late: string[] = [];
			for (const item of wanted) {
				const answer = result.tracks.find(
					(track) => track.trackName === item.track.track_name && track.sessionId === item.sessionId,
				);
				if (!answer || answer.errorCode || !answer.mid) {
					failed.push(item.track.id);
					continue;
				}
				// The publisher can stop or leave while the SFU call runs. Its track must not reach this participant.
				const still = this.sql.exec("SELECT 1 FROM tracks WHERE id = ?", item.track.id).toArray().length > 0;
				const publisher = this.participantRow("id", item.track.participant_id);
				if (!still || publisher?.state !== "admitted") {
					late.push(answer.mid);
					failed.push(item.track.id);
					continue;
				}
				this.sql.exec(
					"INSERT INTO pulls (subscriber_id, mid, track_id, publisher_id, session_epoch) VALUES (?, ?, ?, ?, ?)",
					row.id,
					answer.mid,
					item.track.id,
					item.track.participant_id,
					row.session_epoch,
				);
				out.push({ id: item.track.id, mid: answer.mid });
			}
			if (late.length > 0) {
				this.queueCloses(row.id, row.sfu_session_id, late);
				this.kick();
			}
			if (result.offer) this.sql.exec("UPDATE participants SET awaiting_answer = 1 WHERE id = ?", row.id);
			return { offer: result.offer, tracks: out, failed };
		});
	}

	async answer(tokenHash: string, input: { session: number; sdp: string }): Promise<{ ok: true } | Refusal> {
		const first = this.admittedByToken(tokenHash);
		if ("error" in first) return first;
		const config = this.config();
		if ("error" in config) return config;
		return this.enqueue(first.id, async () => {
			const row = this.admittedByToken(tokenHash);
			if ("error" in row) return row;
			if (row.session_epoch !== input.session || !row.sfu_session_id) return refuse("conflict", STALE);
			if (row.awaiting_answer !== 1) return refuse("conflict", "No offer waits for an answer.");
			try {
				await renegotiate(config, row.sfu_session_id, input.sdp);
			} catch (error) {
				return this.failure(error);
			}
			this.sql.exec(
				"UPDATE participants SET awaiting_answer = 0 WHERE id = ? AND session_epoch = ?",
				row.id,
				row.session_epoch,
			);
			return { ok: true } as const;
		});
	}

	async setMediaState(tokenHash: string, input: { audioMuted: boolean }): Promise<{ ok: true } | Refusal> {
		const row = this.admittedByToken(tokenHash);
		if ("error" in row) return row;
		const now = Date.now();
		const result = this.sql.exec(
			"UPDATE participants SET audio_muted = ?, last_seen_at = ? WHERE id = ? AND audio_muted != ?",
			input.audioMuted ? 1 : 0,
			now,
			row.id,
			input.audioMuted ? 1 : 0,
		);
		if (result.rowsWritten > 0) this.broadcast();
		return { ok: true };
	}

	// --- Teardown ------------------------------------------------------------------------------------

	/**
	 * Stops the media of participants that are not in the call now. The rows go at once, so no later broker call
	 * can use them, and `pending_closes` gets each track and each pull to close on the SFU in the same block. Then
	 * the object closes them with `force`. A close that fails waits for the alarm. The revoke of the TURN
	 * credential has one try.
	 */
	private async teardown(participantIds: readonly string[]): Promise<void> {
		const turns: string[] = [];
		for (const id of participantIds) {
			const row = this.participantRow("id", id);
			if (!row) continue;
			this.dropMedia(id);
			if (row.turn_username) turns.push(row.turn_username);
			this.sql.exec(
				"UPDATE participants SET sfu_session_id = NULL, awaiting_answer = 0, turn_username = NULL WHERE id = ?",
				id,
			);
		}
		this.broadcast();
		const config = realtimeConfig(this.env);
		await Promise.all([this.flushCloses(false), ...(config ? turns.map((turn) => revokeTurn(config, turn)) : [])]);
	}

	/** Ends or cancels the meeting: each participant leaves, and each socket closes. */
	private async close(status: "ended" | "cancelled", actorId: string): Promise<void> {
		const now = Date.now();
		const live = this.sql
			.exec("SELECT id FROM participants WHERE state IN ('waiting', 'admitted')")
			.toArray()
			.map((row) => row.id as string);
		this.sql.exec(
			"UPDATE meeting SET status = ?, ended_at = ?, ended_by = ?, last_activity_at = ?",
			status,
			now,
			actorId,
			now,
		);
		this.sql.exec(
			"UPDATE participants SET state = 'left', end_reason = ?, left_at = ? WHERE state IN ('waiting', 'admitted')",
			status,
			now,
		);
		this.broadcast();
		for (const socket of this.ctx.getWebSockets()) {
			this.send(socket, { type: "closed", reason: status });
			this.closeSocket(
				socket,
				MEET_SOCKET_CLOSE.over,
				status === "ended" ? "The meeting ended." : "The meeting was cancelled.",
			);
		}
		await this.teardown(live);
		await this.schedule();
	}

	// --- Sockets -------------------------------------------------------------------------------------

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("This object accepts sockets only.", { status: 426 });
		}
		const tokenHash = request.headers.get(TOKEN_HASH_HEADER) ?? "";
		const row = this.byToken(tokenHash);
		if ("error" in row) return Response.json(row, { status: row.error.code === "not_found" ? 404 : 403 });
		const meeting = this.meetingRow() as Row;
		if (!isLive(row.state) || meeting.status !== "open") {
			return Response.json(refuse("conflict", "This participant is not in the meeting now."), { status: 409 });
		}
		const tag = socketTag(row.id);
		const mine = this.ctx.getWebSockets(tag);
		if (mine.length >= MEET_LIMITS.socketsPerParticipant) {
			const oldest = mine
				.map((socket) => ({ socket, state: socket.deserializeAttachment() as SocketState | null }))
				.sort((a, b) => (a.state?.openedAt ?? 0) - (b.state?.openedAt ?? 0))[0];
			if (oldest) this.closeSocket(oldest.socket, MEET_SOCKET_CLOSE.replaced, "The participant opened a newer socket.");
		}
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server, [tag]);
		const now = Date.now();
		server.serializeAttachment({ participantId: row.id, openedAt: now } satisfies SocketState);
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		this.sql.exec("UPDATE participants SET last_seen_at = ? WHERE id = ?", now, row.id);
		this.send(server, { type: "hello", protocol: MEET_SOCKET_PROTOCOL });
		this.send(server, { type: "state", ...this.snapshot(this.participantRow("id", row.id) as ParticipantRow, now) });
		// The others see that the participant is connected now.
		this.broadcast(row.id);
		return new Response(null, {
			status: 101,
			webSocket: client,
			headers: { "sec-websocket-protocol": MEET_SOCKET_SUBPROTOCOL },
		});
	}

	override async webSocketMessage(socket: WebSocket): Promise<void> {
		// The runtime answers `ping`. The client sends nothing else.
		this.closeSocket(socket, 1008, "Unknown meeting socket frame.");
	}

	override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
		this.closeSocket(socket, code, reason);
		const state = socket.deserializeAttachment() as SocketState | null;
		if (!state || !this.exists()) return;
		// The absence of the participant starts now.
		this.sql.exec("UPDATE participants SET last_seen_at = ? WHERE id = ?", Date.now(), state.participantId);
		this.broadcast();
		await this.schedule();
	}

	private closeSocket(socket: WebSocket, code: number, reason: string): void {
		try {
			socket.close(code, reason);
		} catch {
			// Closed already.
		}
	}

	private send(socket: WebSocket, message: MeetSocketMessage): void {
		try {
			socket.send(JSON.stringify(message));
		} catch {
			// The socket closed. Its close handler runs.
		}
	}

	/** Sends `closed` to the sockets of a participant, and closes them. */
	private endSockets(participantId: string, reason: EndReason): void {
		const code =
			reason === "denied" || reason === "removed" || reason === "credential"
				? MEET_SOCKET_CLOSE.refused
				: MEET_SOCKET_CLOSE.over;
		for (const socket of this.ctx.getWebSockets(socketTag(participantId))) {
			this.send(socket, { type: "closed", reason });
			this.closeSocket(socket, code, reason);
		}
	}

	/** Sends the new state to each socket, each with the view of its participant. */
	private broadcast(skip?: string): void {
		this.sql.exec(
			`INSERT INTO meta (key, value) VALUES ('state_version', '1')
			ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
		);
		const now = Date.now();
		for (const socket of this.ctx.getWebSockets()) {
			const state = socket.deserializeAttachment() as SocketState | null;
			if (!state || state.participantId === skip) continue;
			const row = this.participantRow("id", state.participantId);
			if (!row) continue;
			this.send(socket, { type: "state", ...this.snapshot(row, now) });
		}
	}

	// --- Alarm ---------------------------------------------------------------------------------------

	/** Sets the alarm to the next time that something can change by itself. */
	private async schedule(): Promise<void> {
		if (!this.exists()) return;
		const meeting = this.meetingRow() as Row;
		const now = Date.now();
		let next: number;
		if (meeting.status !== "open") {
			next = (meeting.ended_at as number) + ENDED_KEEP_MS;
		} else {
			next = (meeting.last_activity_at as number) + IDLE_KEEP_MS;
			const live = this.sql
				.exec("SELECT * FROM participants WHERE state IN ('waiting', 'admitted')")
				.toArray() as unknown as ParticipantRow[];
			for (const row of live) {
				next = Math.min(next, row.requested_at + MEET_LIMITS.tokenMs);
				if (this.ctx.getWebSockets(socketTag(row.id)).length === 0) {
					next = Math.min(next, row.last_seen_at + (row.state === "waiting" ? LOBBY_ABSENT_MS : CALL_ABSENT_MS));
				}
			}
			if (live.some((row) => row.credential_json !== null)) {
				const checked = Number(
					this.sql.exec("SELECT value FROM meta WHERE key = 'credentials_at'").toArray()[0]?.value ?? 0,
				);
				next = Math.min(next, Math.max(checked + CREDENTIAL_CHECK_MS, now + 1000));
			}
		}
		const close = this.sql.exec("SELECT MIN(next_at) AS at FROM pending_closes").one().at as number | null;
		if (close !== null) next = Math.min(next, close);
		await this.ctx.storage.setAlarm(Math.max(next, now + 1000));
	}

	override async alarm(): Promise<void> {
		if (!this.exists()) return;
		const meeting = this.meetingRow() as Row;
		const now = Date.now();
		if (meeting.status !== "open") {
			if ((meeting.ended_at as number) + ENDED_KEEP_MS <= now) {
				await this.ctx.storage.deleteAlarm();
				await this.ctx.storage.deleteAll();
				return;
			}
			await this.flushCloses(true);
			return;
		}
		if ((meeting.last_activity_at as number) + IDLE_KEEP_MS <= now) {
			await this.close("ended", "system");
			return;
		}
		const live = this.sql
			.exec("SELECT * FROM participants WHERE state IN ('waiting', 'admitted')")
			.toArray() as unknown as ParticipantRow[];
		const gone = new Map<string, EndReason>();
		for (const row of live) {
			if (row.requested_at + MEET_LIMITS.tokenMs <= now) {
				gone.set(row.id, "expired");
				continue;
			}
			if (this.ctx.getWebSockets(socketTag(row.id)).length > 0) continue;
			const limit = row.state === "waiting" ? LOBBY_ABSENT_MS : CALL_ABSENT_MS;
			if (row.last_seen_at + limit <= now) gone.set(row.id, "absent");
		}
		const checked = Number(
			this.sql.exec("SELECT value FROM meta WHERE key = 'credentials_at'").toArray()[0]?.value ?? 0,
		);
		const members = live.filter((row) => row.credential_json !== null && !gone.has(row.id));
		if (members.length > 0 && checked + CREDENTIAL_CHECK_MS <= now) {
			try {
				const refs = members.map((row) => JSON.parse(row.credential_json as string) as CredentialRef);
				const results = await checkCredentials(this.env.DIRECTORY, refs);
				members.forEach((row, index) => {
					if (results[index] === "ended") gone.set(row.id, "credential");
				});
				this.sql.exec(
					"INSERT INTO meta (key, value) VALUES ('credentials_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
					String(now),
				);
			} catch (error) {
				log("warn", "meet: the credential check failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				// The next check waits CREDENTIAL_RETRY_MS. Without this time, the alarm runs each second.
				this.sql.exec(
					"INSERT INTO meta (key, value) VALUES ('credentials_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
					String(now - CREDENTIAL_CHECK_MS + CREDENTIAL_RETRY_MS),
				);
			}
		}
		if (gone.size > 0) {
			for (const [id, reason] of gone) {
				const state = reason === "credential" ? "removed" : "left";
				this.sql.exec(
					"UPDATE participants SET state = ?, end_reason = ?, left_at = ? WHERE id = ?",
					state,
					reason,
					now,
					id,
				);
				this.endSockets(id, reason);
			}
			this.broadcast();
			await this.teardown([...gone.keys()]);
		}
		await this.flushCloses(true);
	}
}
