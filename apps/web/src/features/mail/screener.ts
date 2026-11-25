import type { ScreenerMode, ScreenerSender } from "@asterra/contracts";

/**
 * True when the sidebar shows the Screener of the open mailbox: while the Screener is on, and while senders
 * wait in it after it went off, so a person can still decide for them.
 */
export function showScreener(enabled: boolean, pending: number): boolean {
	return enabled || pending > 0;
}

/** The choices of the Screener setting of a mailbox. The first one tells the current default of the organization. */
export function screenerModeOptions(orgDefault: boolean): { value: ScreenerMode; label: string }[] {
	return [
		{ value: "inherit", label: `Use the default of the organization (now ${orgDefault ? "on" : "off"})` },
		{ value: "on", label: "On" },
		{ value: "off", label: "Off" },
	];
}

/** The name of a sender for a row and a button: the display name with the address, or the address alone. */
export function senderTitle(sender: Pick<ScreenerSender, "name" | "address">): string {
	const name = sender.name?.trim();
	return name && name.toLowerCase() !== sender.address ? `${name} <${sender.address}>` : sender.address;
}
