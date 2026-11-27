import { CALENDAR_LIMITS, canonicalTimeZone, checkWhen, type EventWhenValue, zonedTime } from "@asterra/contracts";

// A small subset of iCalendar (RFC 5545) and iTIP (RFC 5546) for invitations by mail. The parser reads the first
// VEVENT of a calendar part that a mail client wrote. Each value comes from the sender, so the parser cleans each
// text, accepts only plain addresses, and gives no time when it cannot read the time exactly. The builder writes
// the invitations, the changes, the cancellations and the answers of Asterra.

export type PartStat = "NEEDS-ACTION" | "ACCEPTED" | "TENTATIVE" | "DECLINED";

export interface ICalAttendee {
	email: string;
	name: string;
	partstat: PartStat;
}

export interface ICalInvite {
	method: "REQUEST" | "REPLY" | "CANCEL" | "OTHER";
	uid: string;
	/** SEQUENCE. A missing value is 0. */
	sequence: number;
	/** DTSTAMP in UTC ms. A missing or unreadable value is 0. */
	stamp: number;
	title: string;
	description: string;
	location: string;
	/** Null for a floating time, an unknown TZID, or a time that `checkWhen` refuses. */
	when: EventWhenValue | null;
	organizer: { email: string; name: string } | null;
	attendees: ICalAttendee[];
	/** RRULE, RDATE, EXDATE, RECURRENCE-ID, or more than one VEVENT. Asterra has no recurring events yet. */
	recurring: boolean;
	/** STATUS:CANCELLED. */
	cancelled: boolean;
}

/** The attendees that the parser reads at most. */
const MAX_ATTENDEES = 500;
/** The longest UID that the parser accepts. */
const MAX_UID = 255;

const EMAIL =
	/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/**
 * The Windows names of time zones that Outlook and Exchange write in TZID, and the IANA name of each. The list
 * has the common zones only. An unknown name gives no time.
 */
const WINDOWS_ZONES: Record<string, string> = {
	"Dateline Standard Time": "Etc/GMT+12",
	"Hawaiian Standard Time": "Pacific/Honolulu",
	"Alaskan Standard Time": "America/Anchorage",
	"Pacific Standard Time": "America/Los_Angeles",
	"Pacific Standard Time (Mexico)": "America/Tijuana",
	"US Mountain Standard Time": "America/Phoenix",
	"Mountain Standard Time": "America/Denver",
	"Central America Standard Time": "America/Guatemala",
	"Central Standard Time": "America/Chicago",
	"Central Standard Time (Mexico)": "America/Mexico_City",
	"Canada Central Standard Time": "America/Regina",
	"SA Pacific Standard Time": "America/Bogota",
	"Eastern Standard Time": "America/New_York",
	"US Eastern Standard Time": "America/Indiana/Indianapolis",
	"Atlantic Standard Time": "America/Halifax",
	"SA Western Standard Time": "America/La_Paz",
	"Newfoundland Standard Time": "America/St_Johns",
	"E. South America Standard Time": "America/Sao_Paulo",
	"Argentina Standard Time": "America/Buenos_Aires",
	"Greenland Standard Time": "America/Godthab",
	UTC: "UTC",
	"Coordinated Universal Time": "UTC",
	"GMT Standard Time": "Europe/London",
	"Greenwich Standard Time": "Atlantic/Reykjavik",
	"W. Europe Standard Time": "Europe/Berlin",
	"Central Europe Standard Time": "Europe/Budapest",
	"Romance Standard Time": "Europe/Paris",
	"Central European Standard Time": "Europe/Warsaw",
	"W. Central Africa Standard Time": "Africa/Lagos",
	"GTB Standard Time": "Europe/Bucharest",
	"FLE Standard Time": "Europe/Kiev",
	"Israel Standard Time": "Asia/Jerusalem",
	"South Africa Standard Time": "Africa/Johannesburg",
	"Egypt Standard Time": "Africa/Cairo",
	"Turkey Standard Time": "Europe/Istanbul",
	"Russian Standard Time": "Europe/Moscow",
	"Arabian Standard Time": "Asia/Dubai",
	"Iran Standard Time": "Asia/Tehran",
	"Pakistan Standard Time": "Asia/Karachi",
	"India Standard Time": "Asia/Kolkata",
	"Nepal Standard Time": "Asia/Katmandu",
	"Bangladesh Standard Time": "Asia/Dhaka",
	"SE Asia Standard Time": "Asia/Bangkok",
	"China Standard Time": "Asia/Shanghai",
	"Singapore Standard Time": "Asia/Singapore",
	"Taipei Standard Time": "Asia/Taipei",
	"W. Australia Standard Time": "Australia/Perth",
	"Tokyo Standard Time": "Asia/Tokyo",
	"Korea Standard Time": "Asia/Seoul",
	"Cen. Australia Standard Time": "Australia/Adelaide",
	"AUS Eastern Standard Time": "Australia/Sydney",
	"E. Australia Standard Time": "Australia/Brisbane",
	"New Zealand Standard Time": "Pacific/Auckland",
};

interface ContentLine {
	name: string;
	params: Map<string, string>;
	value: string;
}

/** Reads one content line: `NAME;PARAM=value;PARAM="quoted":value`. Null for a line that has no colon. */
function contentLine(line: string): ContentLine | null {
	let index = 0;
	const nameEnd = line.search(/[;:]/);
	if (nameEnd <= 0) return null;
	const name = line.slice(0, nameEnd).toUpperCase();
	index = nameEnd;
	const params = new Map<string, string>();
	while (line[index] === ";") {
		index++;
		const eq = line.indexOf("=", index);
		if (eq < 0) return null;
		const key = line.slice(index, eq).toUpperCase();
		index = eq + 1;
		let value = "";
		if (line[index] === '"') {
			const close = line.indexOf('"', index + 1);
			if (close < 0) return null;
			value = line.slice(index + 1, close);
			index = close + 1;
			// A list of values: take the first one.
			while (line[index] === ",") {
				const next = line.slice(index + 1).search(/[;:]/);
				index = next < 0 ? line.length : index + 1 + next;
			}
		} else {
			const end = line.slice(index).search(/[;:]/);
			value = end < 0 ? line.slice(index) : line.slice(index, index + end);
			index = end < 0 ? line.length : index + end;
		}
		params.set(key, value);
	}
	if (line[index] !== ":") return null;
	return { name, params, value: line.slice(index + 1) };
}

/** The text value of a property (RFC 5545 3.3.11), without its escapes. */
function unescapeText(value: string): string {
	return value.replace(/\\([\\;,nN])/g, (_match, char: string) => (char === "n" || char === "N" ? "\n" : char));
}

/** Removes control characters. `lines` keeps tabs and line breaks. */
function clean(value: string, max: number, lines = false): string {
	const kept = value
		.replace(/\r\n?/g, "\n")
		.replace(/\p{Cc}/gu, (char) => (lines && (char === "\n" || char === "\t") ? char : " "));
	return [...kept.trim()].slice(0, max).join("").trim();
}

/** The address of a `mailto:` value, in lowercase, or null when it is not one plain address. */
function mailto(value: string): string | null {
	const address = value
		.replace(/^mailto:/i, "")
		.trim()
		.toLowerCase();
	return address.length <= 254 && EMAIL.test(address) ? address : null;
}

function nameOf(params: Map<string, string>): string {
	return clean(params.get("CN") ?? "", 200);
}

function partstat(value: string | undefined): PartStat {
	const upper = (value ?? "").toUpperCase();
	return upper === "ACCEPTED" || upper === "TENTATIVE" || upper === "DECLINED" ? upper : "NEEDS-ACTION";
}

/** A date-time or a date value. */
type TimeValue = { kind: "date"; date: string } | { kind: "instant"; ms: number; zone: string } | null;

/** The longest DURATION that the parser reads: longer than the longest event. */
const MAX_DURATION_MS = 1000 * 86_400_000;

/** True for a real day of the calendar. `Date.UTC` changes a day such as month 13 into a different day. */
function realDate(y: number, mo: number, d: number): boolean {
	const date = new Date(Date.UTC(y, mo - 1, d));
	return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const DATE_VALUE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_VALUE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

/** The IANA name of a TZID: an IANA name, or a Windows name that Outlook writes. Null when Asterra does not know it. */
function zoneOf(tzid: string): string | null {
	const trimmed = tzid.replace(/^\//, "").trim();
	return canonicalTimeZone(trimmed) ?? WINDOWS_ZONES[trimmed] ?? null;
}

function timeValue(line: ContentLine | undefined): TimeValue {
	if (!line) return null;
	const value = line.value.trim();
	const date = DATE_VALUE.exec(value);
	if (date && (line.params.get("VALUE") ?? "DATE").toUpperCase() === "DATE") {
		if (!realDate(Number(date[1]), Number(date[2]), Number(date[3]))) return null;
		return { kind: "date", date: `${date[1]}-${date[2]}-${date[3]}` };
	}
	const match = DATE_TIME_VALUE.exec(value);
	if (!match) return null;
	const [, y, mo, d, h, mi, s, utc] = match;
	// A sender can write each digit. A value that is not a real time gives no time, never an error.
	if (!realDate(Number(y), Number(mo), Number(d)) || Number(h) > 23 || Number(mi) > 59 || Number(s) > 60) return null;
	if (utc) {
		const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
		return Number.isNaN(ms) ? null : { kind: "instant", ms, zone: "UTC" };
	}
	const tzid = line.params.get("TZID");
	// A time with no zone is a floating time: it has no instant.
	if (!tzid) return null;
	const zone = zoneOf(tzid);
	if (!zone) return null;
	const ms = zonedTime(`${y}-${mo}-${d}`, `${h}:${mi}`, zone) + Number(s) * 1000;
	return Number.isNaN(ms) ? null : { kind: "instant", ms, zone };
}

/** A DURATION (RFC 5545 3.3.6) in ms, or null. Only a positive duration counts. */
function durationMs(value: string | undefined): number | null {
	const match = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec((value ?? "").trim());
	if (!match) return null;
	const [, w, d, h, m, s] = match.map((part) => Number(part ?? 0));
	const ms = ((((w ?? 0) * 7 + (d ?? 0)) * 24 + (h ?? 0)) * 60 + (m ?? 0)) * 60_000 + (s ?? 0) * 1000;
	return ms > 0 && ms <= MAX_DURATION_MS ? ms : null;
}

function whenOf(start: TimeValue, end: TimeValue, duration: number | null): EventWhenValue | null {
	if (!start) return null;
	let when: EventWhenValue;
	if (start.kind === "date") {
		let endDate: string;
		if (end?.kind === "date") endDate = end.date;
		else if (!end && duration !== null && duration % 86_400_000 === 0) {
			endDate = new Date(Date.parse(`${start.date}T00:00:00Z`) + duration).toISOString().slice(0, 10);
		} else if (!end && duration === null) {
			endDate = new Date(Date.parse(`${start.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
		} else return null;
		when = { kind: "all_day", start_date: start.date, end_date: endDate };
	} else {
		let endMs: number;
		if (end?.kind === "instant") endMs = end.ms;
		else if (!end && duration !== null) endMs = start.ms + duration;
		else return null;
		when = {
			kind: "timed",
			start: new Date(start.ms).toISOString(),
			end: new Date(endMs).toISOString(),
			time_zone: start.zone,
		};
	}
	return checkWhen(when) === null ? when : null;
}

/**
 * Reads the first VEVENT of a calendar part. Null for a text over `CALENDAR_LIMITS.icsBytes`, a text with no
 * VCALENDAR and VEVENT, or an event with no usable UID.
 */
export function parseICalendar(text: string): ICalInvite | null {
	if (new TextEncoder().encode(text).byteLength > CALENDAR_LIMITS.icsBytes) return null;
	const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
	const stack: string[] = [];
	let method: ICalInvite["method"] = "OTHER";
	let events = 0;
	let recurring = false;
	const props = new Map<string, ContentLine>();
	const attendees: ContentLine[] = [];
	for (const raw of lines) {
		if (raw.trim() === "") continue;
		const line = contentLine(raw);
		if (!line) continue;
		if (line.name === "BEGIN") {
			const component = line.value.trim().toUpperCase();
			stack.push(component);
			if (component === "VEVENT" && stack.length === 2 && stack[0] === "VCALENDAR") events++;
			continue;
		}
		if (line.name === "END") {
			stack.pop();
			continue;
		}
		if (stack.length === 1 && stack[0] === "VCALENDAR" && line.name === "METHOD") {
			const value = line.value.trim().toUpperCase();
			method = value === "REQUEST" || value === "REPLY" || value === "CANCEL" ? value : "OTHER";
			continue;
		}
		// Only the properties of the first VEVENT, not of its VALARM, and not of a VTIMEZONE.
		if (!(stack.length === 2 && stack[0] === "VCALENDAR" && stack[1] === "VEVENT" && events === 1)) continue;
		if (["RRULE", "RDATE", "EXDATE", "RECURRENCE-ID"].includes(line.name)) recurring = true;
		if (line.name === "ATTENDEE") {
			if (attendees.length < MAX_ATTENDEES) attendees.push(line);
		} else if (!props.has(line.name)) props.set(line.name, line);
	}
	if (events === 0) return null;
	const uid = clean(props.get("UID")?.value ?? "", MAX_UID + 1);
	if (uid === "" || uid.length > MAX_UID) return null;
	const sequence = Number.parseInt(props.get("SEQUENCE")?.value.trim() ?? "0", 10);
	const stampValue = timeValue(props.get("DTSTAMP"));
	const organizerLine = props.get("ORGANIZER");
	const organizerEmail = organizerLine ? mailto(organizerLine.value) : null;
	const attendeeList: ICalAttendee[] = [];
	const seen = new Set<string>();
	for (const line of attendees) {
		const email = mailto(line.value) ?? mailto(line.params.get("EMAIL") ?? "");
		if (!email || seen.has(email)) continue;
		seen.add(email);
		attendeeList.push({ email, name: nameOf(line.params), partstat: partstat(line.params.get("PARTSTAT")) });
	}
	const duration = durationMs(props.get("DURATION")?.value);
	const title = clean(unescapeText(props.get("SUMMARY")?.value ?? ""), CALENDAR_LIMITS.titleChars);
	return {
		method,
		uid,
		sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0,
		stamp: stampValue?.kind === "instant" ? stampValue.ms : 0,
		title: title === "" ? "(No title)" : title,
		description: clean(unescapeText(props.get("DESCRIPTION")?.value ?? ""), CALENDAR_LIMITS.descriptionChars, true),
		location: clean(unescapeText(props.get("LOCATION")?.value ?? ""), CALENDAR_LIMITS.locationChars),
		// A DURATION that the parser cannot read gives no time: a guess of the end is not exact.
		// A DTEND or a DURATION that is there but not readable gives no time. A missing one has a default.
		when:
			(props.has("DTEND") && timeValue(props.get("DTEND")) === null) ||
			(props.has("DURATION") && !props.has("DTEND") && duration === null)
				? null
				: whenOf(timeValue(props.get("DTSTART")), timeValue(props.get("DTEND")), duration),
		organizer: organizerLine && organizerEmail ? { email: organizerEmail, name: nameOf(organizerLine.params) } : null,
		attendees: attendeeList,
		recurring: recurring || events > 1,
		cancelled: (props.get("STATUS")?.value.trim().toUpperCase() ?? "") === "CANCELLED",
	};
}

/** The fields of an event that the builder writes. */
export interface ICalFields {
	title: string;
	description: string;
	location: string;
	all_day: boolean;
	start_at: number;
	end_at: number;
	start_date: string | null;
	end_date: string | null;
}

export interface ICalOutput {
	method: "REQUEST" | "REPLY" | "CANCEL";
	uid: string;
	sequence: number;
	/** DTSTAMP in UTC ms. */
	stamp: number;
	fields: ICalFields;
	organizer: { email: string; name: string };
	/** A REPLY has only the attendee who answers. */
	attendees: ICalAttendee[];
}

function escapeText(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,")
		.replace(/\r\n?|\n/g, "\\n")
		.replace(/\p{Cc}/gu, " ");
}

/** A CN parameter in double quotes. A quote or a control character cannot end the parameter. */
function cnParam(name: string): string {
	const safe = name.replace(/["\p{Cc}]/gu, "").trim();
	return safe === "" ? "" : `;CN="${safe}"`;
}

function utcStamp(ms: number): string {
	return new Date(ms)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
}

function dateStamp(date: string): string {
	return date.replace(/-/g, "");
}

/** Folds a content line at 75 octets (RFC 5545 3.1). A fold never splits a UTF-8 sequence. */
function fold(line: string): string {
	const encoder = new TextEncoder();
	const parts: string[] = [];
	let current = "";
	let size = 0;
	for (const char of line) {
		const bytes = encoder.encode(char).byteLength;
		// The first line has 75 octets. Each next line starts with a space, so it has 74 more.
		if (size + bytes > 75) {
			parts.push(current);
			current = ` ${char}`;
			size = 1 + bytes;
		} else {
			current += char;
			size += bytes;
		}
	}
	parts.push(current);
	return parts.join("\r\n");
}

/** Writes a VCALENDAR with one VEVENT for an invitation, a change, a cancellation or an answer. */
export function buildICalendar(input: ICalOutput): string {
	const { fields } = input;
	const lines = [
		"BEGIN:VCALENDAR",
		"PRODID:-//Asterra//Calendar//EN",
		"VERSION:2.0",
		"CALSCALE:GREGORIAN",
		`METHOD:${input.method}`,
		"BEGIN:VEVENT",
		// The parser keeps the UID of a mail as its sender wrote it, so an answer writes it back with no new escape.
		`UID:${input.uid.replace(/\p{Cc}/gu, "")}`,
		`SEQUENCE:${input.sequence}`,
		`DTSTAMP:${utcStamp(input.stamp)}`,
	];
	if (fields.all_day && fields.start_date && fields.end_date) {
		lines.push(`DTSTART;VALUE=DATE:${dateStamp(fields.start_date)}`, `DTEND;VALUE=DATE:${dateStamp(fields.end_date)}`);
	} else {
		lines.push(`DTSTART:${utcStamp(fields.start_at)}`, `DTEND:${utcStamp(fields.end_at)}`);
	}
	lines.push(`SUMMARY:${escapeText(fields.title)}`);
	if (fields.location) lines.push(`LOCATION:${escapeText(fields.location)}`);
	if (fields.description) lines.push(`DESCRIPTION:${escapeText(fields.description)}`);
	lines.push(`ORGANIZER${cnParam(input.organizer.name)}:mailto:${input.organizer.email}`);
	for (const attendee of input.attendees) {
		const rsvp = input.method === "REQUEST" && attendee.partstat === "NEEDS-ACTION" ? ";RSVP=TRUE" : "";
		lines.push(
			`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${attendee.partstat}${rsvp}${cnParam(attendee.name)}:mailto:${attendee.email}`,
		);
	}
	lines.push(
		`STATUS:${input.method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
		"TRANSP:OPAQUE",
		"END:VEVENT",
		"END:VCALENDAR",
	);
	return `${lines.map(fold).join("\r\n")}\r\n`;
}
