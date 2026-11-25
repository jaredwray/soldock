import type { ScreenerMode, ScreenerSender } from "@asterra/contracts";
import type { MailView } from "../../routes.ts";

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

/**
 * True when the view is a search that names the mail that the Screener holds (`in:screener` or
 * `in:screened_out`, also in quotes, as the server reads them). The Screener view opens held mail in these
 * searches. On held mail, the server changes only the read state and the star, so the pane offers no other
 * action there.
 */
export function showsHeldMail(view: MailView): boolean {
	return view.kind === "search" && /(^|[\s(])in:("?)(screener|screened_out)\2(?=$|[\s)])/i.test(view.query);
}

/**
 * The toast text after a person screens a sender out. While the Screener is off, the mailbox holds no new
 * mail, so the text tells that the decision waits.
 */
export function screenedOutNotice(address: string, enabled: boolean): string {
	return enabled
		? `You will not see new mail from ${address}. The sender is not told.`
		: `The decision for ${address} is stored. New mail from the sender comes to the inbox while the Screener is off.`;
}

/** The name of a sender for a row and a button: the display name with the address, or the address alone. */
export function senderTitle(sender: Pick<ScreenerSender, "name" | "address">): string {
	const name = sender.name?.trim();
	return name && name.toLowerCase() !== sender.address ? `${name} <${sender.address}>` : sender.address;
}
