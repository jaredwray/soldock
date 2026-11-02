import type { Address } from "@soldock/contracts";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const yearFormat = new Intl.DateTimeFormat(undefined, { year: "2-digit", month: "numeric", day: "numeric" });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A short date for a list: the time for today, the day for this year, and the full date before. */
export function shortDate(iso: string, now: Date = new Date()): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	if (date.toDateString() === now.toDateString()) return timeFormat.format(date);
	if (date.getFullYear() === now.getFullYear()) return dayFormat.format(date);
	return yearFormat.format(date);
}

export function fullDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : fullFormat.format(date);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The display name of an address, or the address when it has no name. */
export function addressName(address: Address): string {
	const name = address.name?.trim();
	return name ? name : address.address;
}

/** `Ada Lovelace <ada@example.com>`, or the address alone. */
export function formatAddress(address: Address): string {
	const name = address.name?.trim();
	return name ? `${name} <${address.address}>` : address.address;
}

export function sameAddress(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The people of a thread for a list row. Your own address shows as "me". */
export function participantsLabel(participants: readonly Address[], myAddress: string): string {
	const names = participants.map((participant) =>
		sameAddress(participant.address, myAddress) ? "me" : firstName(addressName(participant)),
	);
	const unique = [...new Set(names)];
	return unique.length > 0 ? unique.join(", ") : "(no sender)";
}

function firstName(name: string): string {
	if (name.includes("@")) return name.split("@")[0] ?? name;
	return name;
}

export function initials(name: string): string {
	const letters = name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase() ?? "");
	return letters.join("") || "?";
}

export function plural(count: number, one: string, many: string = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}
