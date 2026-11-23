import type { AutoLabelSettings } from "@asterra/contracts";

/** The text next to a label that auto labels applied, for a screen reader. */
export const AUTO_MARK_TEXT = " (auto label)";
/** The tooltip of the mark. */
export const AUTO_MARK_TITLE = "Applied by auto labels";

/** A sentence that says why auto labels cannot run in this mailbox now, or null when they can. */
export function unavailableText(settings: Pick<AutoLabelSettings, "available" | "unavailable_reason">): string | null {
	if (settings.available) return null;
	return settings.unavailable_reason === "feature_off"
		? "An owner or an admin must turn on inbox auto labels in Admin › AI. Until then, auto labels apply no labels."
		: "An owner or an admin must turn on AI in Admin › AI. Until then, auto labels apply no labels.";
}

/**
 * True when a change removes a label that auto labels applied to one of the threads. Auto labels then
 * learn from the change, and the web app says so.
 */
export function removesAutoLabel(
	threads: readonly { auto_label_ids: readonly string[] }[],
	removed: readonly string[],
): boolean {
	return threads.some((thread) => removed.some((id) => thread.auto_label_ids.includes(id)));
}
