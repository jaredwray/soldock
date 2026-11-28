import { Timestamp } from "./common.ts";
import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

// Meet: browser meetings with audio and video. Cloudflare Realtime carries the media. Asterra keeps the state of
// each meeting, the lobby, the admission and the permissions. A member of the organization hosts a meeting. A guest
// from outside opens the link, asks to join, and waits in the lobby until the host admits the guest.

export const MEET_LIMITS = {
	titleChars: 120,
	displayNameChars: 60,
	/** The participants that are in the call at one time. */
	admitted: 16,
	/** The guests that wait in the lobby at one time. */
	waiting: 20,
	/** The participant rows of the guests of one meeting. Each join request of a guest adds a row. */
	participantRows: 500,
	/** The join requests of guests that one meeting accepts in one minute. */
	guestJoinsPerMinute: 30,
	/** The join requests of one signed-in member that one meeting accepts in one minute. */
	memberJoinsPerMinute: 10,
	/** The most bytes of one SDP text. */
	sdpBytes: 64 * 1024,
	/** The sockets of one participant. A new socket closes the oldest. */
	socketsPerParticipant: 2,
	/** A participant token stops after this time, in ms. */
	tokenMs: 24 * 60 * 60 * 1000,
} as const;

/** The characters of a meeting code: lowercase Crockford base32, without i, l, o and u. */
export const MEETING_CODE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const CODE_GROUP = "[0-9a-hjkmnp-tv-z]{4}";
const CODE_PATTERN = new RegExp(`^${CODE_GROUP}(?:-${CODE_GROUP}){3}$`);

/** True for a meeting code in its canonical form, such as `k7qm-2x9d-ptw4-hs6n`. */
export function isMeetingCode(value: string): boolean {
	return CODE_PATTERN.test(value);
}

/**
 * The canonical code of a code or a link that a person pastes: `https://host/meet/K7QM-2X9D-PTW4-HS6N`,
 * `k7qm2x9dptw4hs6n` and `k7qm-2x9d-ptw4-hs6n` give the same code. Null when the text holds no code.
 */
export function parseMeetingCode(text: string): string | null {
	const trimmed = text.trim();
	const fromPath = /\/meet\/([^/?#]+)/.exec(trimmed);
	let part = trimmed;
	if (fromPath) {
		try {
			part = decodeURIComponent(fromPath[1] as string);
		} catch {
			// A path with a bad percent escape holds no code.
			return null;
		}
	}
	const raw = part.toLowerCase().replaceAll("-", "");
	if (!/^[0-9a-hjkmnp-tv-z]{16}$/.test(raw)) return null;
	return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`;
}

/** The path of the page of a meeting, on the host of Asterra. */
export function meetPath(code: string): string {
	return `/meet/${encodeURIComponent(code)}`;
}

export const MeetingCode = z
	.string()
	.refine(isMeetingCode, "must be a meeting code, such as k7qm-2x9d-ptw4-hs6n")
	.describe("The code of a meeting: the last part of its link, such as k7qm-2x9d-ptw4-hs6n.");

export const ParticipantId = z
	.string()
	.regex(/^par_[0-9A-HJKMNP-TV-Z]{26}$/, "must be the id of a participant: it starts with par_")
	.describe("The id of a participant, as meet.list_participants returns it.");

const CONTROL = /\p{Cc}/u;
/**
 * Control characters, and the format characters that change the direction of text or that are not visible. The
 * joiners U+200C and U+200D are permitted: Persian and Indic names and some emoji need them.
 */
const CONTROL_OR_FORMAT = /\p{Cc}|[^\P{Cf}\u200C\u200D]/u;

export const MeetingTitle = z
	.string()
	.trim()
	.max(MEET_LIMITS.titleChars)
	.refine((value) => !CONTROL.test(value), "must not contain control characters");

export const MeetDisplayName = z
	.string()
	.trim()
	.min(1, "Enter your name.")
	.max(MEET_LIMITS.displayNameChars)
	.refine((value) => !CONTROL_OR_FORMAT.test(value), "must not contain control characters or format characters")
	.refine((value) => value.replace(/[\u200C\u200D]/g, "").trim() !== "", "Enter your name.");

export const MeetingStatus = z.enum(["open", "ended", "cancelled"]);
export type MeetingStatus = z.infer<typeof MeetingStatus>;

export const ParticipantState = z.enum(["waiting", "admitted", "denied", "left", "removed"]);
export type ParticipantState = z.infer<typeof ParticipantState>;

/** Why a participant is not in the meeting now. */
export const EndReason = z.enum(["denied", "removed", "left", "absent", "ended", "cancelled", "credential", "expired"]);
export type EndReason = z.infer<typeof EndReason>;

export const Meeting = z.object({
	id: z.string(),
	code: z.string(),
	/** The link to share. A guest opens it to ask to join. */
	join_url: z.string(),
	title: z.string(),
	status: MeetingStatus,
	/** `calendar` for the meeting of a calendar event. */
	origin: z.enum(["standalone", "calendar"]),
	event_id: z.string().nullable(),
	host: z.object({ principal_id: z.string(), display_name: z.string() }),
	/** The participants in the lobby now. */
	waiting: z.number().int(),
	/** The participants in the call now. */
	admitted: z.number().int(),
	created_at: Timestamp,
	ended_at: Timestamp.nullable(),
});
export type Meeting = z.infer<typeof Meeting>;

export const Participant = z.object({
	id: z.string(),
	/** `member`: a principal of the organization. `guest`: a person from outside, with only a display name. */
	kind: z.enum(["member", "guest"]),
	principal_id: z.string().nullable(),
	display_name: z.string(),
	role: z.enum(["host", "participant"]),
	state: ParticipantState,
	/** True while the browser of the participant is connected. */
	connected: z.boolean(),
	/** True while the participant sends audio and is not muted. */
	audio: z.boolean(),
	/** True while the participant sends video. */
	video: z.boolean(),
	requested_at: Timestamp,
	joined_at: Timestamp.nullable(),
	/** True for a guest: the display name comes from outside the organization. */
	untrusted: z.boolean(),
});
export type Participant = z.infer<typeof Participant>;

const HOST_NOTE =
	"Only the host of the meeting can do this: the person, agent or service account that created it, or the owner of the calendar event of the meeting.";

const PARTICIPANT_PATH = "/api/v1/meet/meetings/{code}/participants/{participant_id}";

export const createMeeting = defineOperation({
	name: "meet.create_meeting",
	summary: "Create a meeting link",
	description: [
		"Creates a meeting that you host, and returns its link (join_url).",
		"Share the link with each person who joins. A member of the organization who is signed in joins at once. A guest from outside enters a name and waits in the lobby until the host admits the guest.",
		"The meeting stays open until the host ends it with meet.end_meeting. An ended meeting cannot open again.",
		"Media needs a browser: an agent can create a meeting and admit or remove participants, but it cannot send or receive audio or video.",
		"Returns unavailable when the operator did not set up Meet.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/meet/meetings" },
	scopes: ["meet.write"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z.strictObject({
		title: MeetingTitle.optional().describe(
			"A short title. Each person with the link sees it, also a guest, before the host admits the guest.",
		),
	}),
	output: z.object({ meeting: Meeting }),
	errors: ["unavailable"],
});

export const getMeeting = defineOperation({
	name: "meet.get_meeting",
	summary: "Read a meeting that you host",
	description: [
		"Returns a meeting with its status and the count of participants in the lobby and in the call.",
		HOST_NOTE,
	].join(" "),
	http: { method: "GET", path: "/api/v1/meet/meetings/{code}" },
	scopes: ["meet.read"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({ code: MeetingCode }),
	output: z.object({ meeting: Meeting }),
	errors: ["not_found"],
});

export const endMeeting = defineOperation({
	name: "meet.end_meeting",
	summary: "End a meeting for everyone",
	description: [
		"Ends the meeting for each participant at once: their audio and video stop, and nobody can join again with the link. This cannot be undone.",
		"For the meeting of a calendar event, the call ends for each participant, and the link works again later. To stop the link, remove it from the event or delete the event.",
		"A second call changes nothing.",
		HOST_NOTE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/meet/meetings/{code}/end" },
	scopes: ["meet.write"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ code: MeetingCode }),
	output: z.object({ meeting: Meeting }),
	errors: ["not_found"],
});

export const listParticipants = defineOperation({
	name: "meet.list_participants",
	summary: "List the lobby and the participants of a meeting that you host",
	description: [
		"Returns each participant that waits in the lobby (state waiting) and each participant in the call (state admitted), first request first.",
		"The display name of a guest comes from outside the organization: it is marked untrusted.",
		HOST_NOTE,
	].join(" "),
	http: { method: "GET", path: "/api/v1/meet/meetings/{code}/participants" },
	scopes: ["meet.read"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({ code: MeetingCode }),
	output: z.object({ participants: z.array(Participant) }),
	errors: ["not_found"],
});

const DECISION_INPUT = z.strictObject({ code: MeetingCode, participant_id: ParticipantId });

export const admitParticipant = defineOperation({
	name: "meet.admit_participant",
	summary: "Let a participant in the lobby join the call",
	description: [
		"Admits a participant that waits in the lobby. The participant then sends and receives audio and video.",
		`A meeting has at most ${MEET_LIMITS.admitted} participants in the call: a full meeting gives conflict.`,
		"A participant that is not in the lobby gives conflict. A second admit of the same participant returns it and changes nothing.",
		HOST_NOTE,
	].join(" "),
	http: { method: "POST", path: `${PARTICIPANT_PATH}/admit` },
	scopes: ["meet.write"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: DECISION_INPUT,
	output: z.object({ participant: Participant }),
	errors: ["not_found", "conflict"],
});

export const denyParticipant = defineOperation({
	name: "meet.deny_participant",
	summary: "Refuse a participant in the lobby",
	description: [
		"Refuses a participant that waits in the lobby. Its page tells it that the host refused it. It can ask again with the link.",
		"A participant that is not in the lobby gives conflict. A second deny of the same participant returns it and changes nothing.",
		HOST_NOTE,
	].join(" "),
	http: { method: "POST", path: `${PARTICIPANT_PATH}/deny` },
	scopes: ["meet.write"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: DECISION_INPUT,
	output: z.object({ participant: Participant }),
	errors: ["not_found", "conflict"],
});

export const removeParticipant = defineOperation({
	name: "meet.remove_participant",
	summary: "Remove a participant from the call",
	description: [
		"Removes a participant from the call at once: its audio and video stop, and the others stop receiving them.",
		"A removed participant that asks again waits in the lobby, also a member of the organization.",
		"The host cannot remove itself: end the meeting instead. A second call changes nothing.",
		HOST_NOTE,
	].join(" "),
	http: { method: "POST", path: `${PARTICIPANT_PATH}/remove` },
	scopes: ["meet.write"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: DECISION_INPUT,
	output: z.object({ participant: Participant }),
	errors: ["not_found", "conflict"],
});

export const meetOperations = {
	"meet.create_meeting": createMeeting,
	"meet.get_meeting": getMeeting,
	"meet.end_meeting": endMeeting,
	"meet.list_participants": listParticipants,
	"meet.admit_participant": admitParticipant,
	"meet.deny_participant": denyParticipant,
	"meet.remove_participant": removeParticipant,
} as const;

// The call routes. A browser uses them to join a meeting and to carry its media. They are not operations: a guest
// is not a principal, and an agent has no media. Members and guests use the same routes. Each route after `join`
// needs the participant token in the header MEET_TOKEN_HEADER.

/** The header of the participant token. It is never in Authorization and never in a URL. */
export const MEET_TOKEN_HEADER = "x-asterra-meet-token";

/** The base path of the call routes of a meeting. */
export function meetCallPath(code: string): string {
	return `/api/v1/meet/calls/${encodeURIComponent(code)}`;
}

/** The path of the socket of a meeting. */
export function meetSocketPath(code: string): string {
	return `/ws/meet/${encodeURIComponent(code)}`;
}

/** The version of the socket protocol. The client sends `asterra-meet.v1` and `token.<token>` as subprotocols. */
export const MEET_SOCKET_PROTOCOL = 1;
export const MEET_SOCKET_SUBPROTOCOL = "asterra-meet.v1";

/** The close codes of a meeting socket. */
export const MEET_SOCKET_CLOSE = {
	/** The participant opened a newer socket. Do not open a new socket for this one. */
	replaced: 4002,
	/** The host refused or removed the participant, or its credential stopped. Do not open a new socket. */
	refused: 4403,
	/** The meeting ended, or the participant left. Do not open a new socket. */
	over: 4410,
} as const;

/** What `GET <call path>` returns. Each person with the link can read it. */
export const CallInfo = z.object({
	code: z.string(),
	title: z.string(),
	host_name: z.string(),
	status: MeetingStatus,
	/** `not_configured` when the operator did not set up the media service. */
	media: z.enum(["ready", "not_configured"]),
	/** The signed-in member of this browser, or null for a guest. */
	viewer: z.object({ display_name: z.string(), is_host: z.boolean() }).nullable(),
});
export type CallInfo = z.infer<typeof CallInfo>;

export const JoinRequest = z.strictObject({
	/** Required for a guest. A signed-in member joins with the name of the directory. */
	display_name: MeetDisplayName.optional(),
});

export const SelfState = z.object({
	id: z.string(),
	kind: z.enum(["member", "guest"]),
	role: z.enum(["host", "participant"]),
	state: ParticipantState,
	end_reason: EndReason.nullable(),
	display_name: z.string(),
});
export type SelfState = z.infer<typeof SelfState>;

export const JoinResponse = z.object({ token: z.string(), participant: SelfState });
export type JoinResponse = z.infer<typeof JoinResponse>;

export const RosterTrack = z.object({ id: z.string(), kind: z.enum(["audio", "video"]) });
export type RosterTrack = z.infer<typeof RosterTrack>;

export const RosterEntry = z.object({
	id: z.string(),
	display_name: z.string(),
	kind: z.enum(["member", "guest"]),
	role: z.enum(["host", "participant"]),
	connected: z.boolean(),
	audio_muted: z.boolean(),
	tracks: z.array(RosterTrack),
});
export type RosterEntry = z.infer<typeof RosterEntry>;

export const LobbyEntry = z.object({
	id: z.string(),
	display_name: z.string(),
	kind: z.enum(["member", "guest"]),
	requested_at: Timestamp,
});
export type LobbyEntry = z.infer<typeof LobbyEntry>;

/**
 * The state of a meeting for one participant. `participants` is only for an admitted participant, and `lobby`
 * only for the host. A participant in the lobby sees no other participant.
 */
export const CallState = z.object({
	version: z.number().int(),
	meeting: z.object({ code: z.string(), title: z.string(), host_name: z.string(), status: MeetingStatus }),
	self: SelfState,
	participants: z.array(RosterEntry).optional(),
	lobby: z.array(LobbyEntry).optional(),
});
export type CallState = z.infer<typeof CallState>;

/** A message of the server on the meeting socket. The client sends nothing but `ping`. */
export type MeetSocketMessage =
	| { type: "hello"; protocol: number }
	| ({ type: "state" } & CallState)
	| { type: "closed"; reason: EndReason };

export const IceServer = z.object({
	urls: z.union([z.string(), z.array(z.string())]),
	username: z.string().optional(),
	credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServer>;

/**
 * The form of the mid of a track that a browser sends: 1 to 32 letters, digits, and the characters `_`, `.` and
 * `-`. Browsers make short numbers. The object uses the mid in its records of the SFU, so no other form is accepted.
 */
export const MEET_MID_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;

const Sdp = z.string().min(1).max(MEET_LIMITS.sdpBytes);
const SessionNumber = z.number().int().min(1);
const TrackKind = z.enum(["audio", "video"]);

export const MediaSessionResponse = z.object({ session: z.number().int(), ice_servers: z.array(IceServer) });
export type MediaSessionResponse = z.infer<typeof MediaSessionResponse>;

export const PublishRequest = z.strictObject({
	session: SessionNumber,
	offer: z.strictObject({ sdp: Sdp }),
	tracks: z
		.array(z.strictObject({ mid: z.string().regex(MEET_MID_PATTERN), kind: TrackKind }))
		.min(1)
		.max(2)
		.refine(
			(tracks) => new Set(tracks.map((track) => track.mid)).size === tracks.length,
			"each track needs a different mid",
		)
		.refine(
			(tracks) => new Set(tracks.map((track) => track.kind)).size === tracks.length,
			"send at most one audio and one video track",
		),
});
export const PublishResponse = z.object({
	answer: z.object({ sdp: z.string() }),
	tracks: z.array(z.object({ id: z.string(), kind: TrackKind, mid: z.string() })),
});
export type PublishResponse = z.infer<typeof PublishResponse>;

export const UnpublishRequest = z.strictObject({ session: SessionNumber, kinds: z.array(TrackKind).min(1).max(2) });

export const SubscribeRequest = z.strictObject({
	session: SessionNumber,
	track_ids: z
		.array(z.string().min(1).max(64))
		.min(1)
		.max(2 * MEET_LIMITS.admitted),
});
export const SubscribeResponse = z.object({
	offer: z.object({ sdp: z.string() }).nullable(),
	tracks: z.array(z.object({ id: z.string(), mid: z.string() })),
	/** The ids of the tracks that the server did not add. */
	failed: z.array(z.string()),
});
export type SubscribeResponse = z.infer<typeof SubscribeResponse>;

export const AnswerRequest = z.strictObject({ session: SessionNumber, answer: z.strictObject({ sdp: Sdp }) });

export const MediaStateRequest = z.strictObject({ audio_muted: z.boolean() });
