import { type InputOf, MeetRealtimeId, MeetRealtimeSecret, type MeetSettings } from "@asterra/contracts";

/** One pair of Admin › Meet: the SFU app (App ID and App Secret) or the TURN key (Key ID and API token). */
export interface PairDraft {
	/** The ID as typed. */
	id: string;
	/** A new secret, as typed. Empty: no change. A saved secret never comes back to the web app. */
	secret: string;
	/** True when the person removes the saved pair at the next save. */
	remove: boolean;
}

export interface MeetDraft {
	sfu: PairDraft;
	turn: PairDraft;
}

export function draftOf(settings: MeetSettings): MeetDraft {
	return {
		sfu: { id: settings.app_id ?? "", secret: "", remove: false },
		turn: { id: settings.turn_key_id ?? "", secret: "", remove: false },
	};
}

/** The names of one pair, for the request and for the texts of the form. */
export interface PairNames {
	idKey: "app_id" | "turn_key_id";
	secretKey: "app_secret" | "turn_key_token";
	idLabel: string;
	secretLabel: string;
}

export const SFU_NAMES: PairNames = {
	idKey: "app_id",
	secretKey: "app_secret",
	idLabel: "App ID",
	secretLabel: "App Secret",
};

export const TURN_NAMES: PairNames = {
	idKey: "turn_key_id",
	secretKey: "turn_key_token",
	idLabel: "TURN Key ID",
	secretLabel: "TURN key API token",
};

type Patch = InputOf<"meet.update_settings">;

/** The first message of a value that the server does not accept, or null. */
function problemOf(result: { success: boolean; error?: { issues: { message: string }[] } }): string | null {
	return result.success ? null : (result.error?.issues[0]?.message ?? "The value is not valid.");
}

/** The change of one pair, or a problem to show. `saved` is the saved ID, or null. */
function pairChange(
	draft: PairDraft,
	saved: string | null,
	names: PairNames,
): { patch: Patch; problem: string | null } {
	if (draft.remove) return { patch: { [names.idKey]: null, [names.secretKey]: null }, problem: null };
	const id = draft.id.trim().toLowerCase();
	const secret = draft.secret.trim();
	if (id === (saved ?? "")) {
		if (secret === "") return { patch: {}, problem: null };
		if (id === "") return { patch: {}, problem: `Enter the ${names.idLabel} of the ${names.secretLabel}.` };
		const secretProblem = problemOf(MeetRealtimeSecret.safeParse(secret));
		return { patch: { [names.secretKey]: secret }, problem: secretProblem && `${names.secretLabel}: ${secretProblem}` };
	}
	// An empty ID removes the saved pair.
	if (id === "") return { patch: { [names.idKey]: null, [names.secretKey]: null }, problem: null };
	const idProblem = problemOf(MeetRealtimeId.safeParse(id));
	if (idProblem) return { patch: {}, problem: `${names.idLabel}: ${idProblem}` };
	if (secret === "") return { patch: {}, problem: `Paste the ${names.secretLabel} of the new ${names.idLabel}.` };
	const secretProblem = problemOf(MeetRealtimeSecret.safeParse(secret));
	if (secretProblem) return { patch: {}, problem: `${names.secretLabel}: ${secretProblem}` };
	return { patch: { [names.idKey]: id, [names.secretKey]: secret }, problem: null };
}

/** The request of a save, with the first problem of the form. An empty patch changes nothing. */
export function changeOf(draft: MeetDraft, settings: MeetSettings): { patch: Patch; problem: string | null } {
	const sfu = pairChange(draft.sfu, settings.app_id, SFU_NAMES);
	const turn = pairChange(draft.turn, settings.turn_key_id, TURN_NAMES);
	return { patch: { ...sfu.patch, ...turn.patch }, problem: sfu.problem ?? turn.problem };
}

/** The status line of the section. */
export function statusText(settings: MeetSettings): string {
	if (settings.ready) {
		return settings.turn_source
			? "Meet is ready. People can create and join meetings."
			: "Meet is ready. Without a TURN key, a network that blocks UDP cannot carry the media.";
	}
	return settings.not_ready_reason === "api_base"
		? "Meet is off: the Worker variable REALTIME_API_BASE is not an https URL."
		: "Meet is off. Save the App ID and the App Secret of a Realtime SFU app.";
}
