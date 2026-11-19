import { DOC_LIMITS, type DocImageCrop, type DocImageLayout } from "@soldock/contracts";

// The geometry of an image in a doc: its shown size, a resize with a handle, and a crop. Each function
// works on numbers only, so the Node tests can run them without a DOM.

export interface Size {
	width: number;
	height: number;
}

/** The whole image: no crop. */
export const FULL_CROP: DocImageCrop = { x: 0, y: 0, width: 1, height: 1 };

/** The smallest shown width that a handle or the toolbar makes. A smaller image is hard to select. */
export const MIN_SHOWN_WIDTH = 24;

/** The pixels of the part of the file that shows. */
export function shownSize(natural: Size, crop: DocImageCrop | null): Size {
	const part = crop ?? FULL_CROP;
	return { width: natural.width * part.width, height: natural.height * part.height };
}

/** The width of an image without a width of its own: the width of its shown part, at most the width of the text. */
export function fitWidth(natural: Size, crop: DocImageCrop | null, available: number): number {
	const limit = Math.max(MIN_SHOWN_WIDTH, Math.min(available, DOC_LIMITS.imageMaxWidth));
	return Math.max(DOC_LIMITS.imageMinWidth, Math.min(Math.round(shownSize(natural, crop).width), Math.round(limit)));
}

/** The corner that a person moves to change the size of an image. */
export type Corner = "nw" | "ne" | "sw" | "se";

/**
 * The new width of an image after a corner moved `dx` pixels to the right. A corner at the left makes
 * the image larger when it moves to the left. An image in the center grows at its two sides, so its
 * width changes two times as fast and the corner stays below the pointer.
 */
export function resizedWidth(start: number, dx: number, corner: Corner, layout: DocImageLayout, max: number): number {
	const outward = corner === "nw" || corner === "sw" ? -dx : dx;
	const width = start + outward * (layout === "break_center" ? 2 : 1);
	const limit = Math.max(MIN_SHOWN_WIDTH, Math.min(max, DOC_LIMITS.imageMaxWidth));
	return Math.round(Math.max(MIN_SHOWN_WIDTH, Math.min(width, limit)));
}

/** The CSS of the picture in its frame, in percent of the frame. The frame shows only the crop. */
export function cropStyle(crop: DocImageCrop | null): { width: string; height: string; left: string; top: string } {
	const part = crop ?? FULL_CROP;
	const percent = (value: number) => `${Math.round(value * 1_000_000) / 10_000}%`;
	return {
		width: percent(1 / part.width),
		height: percent(1 / part.height),
		left: percent(-part.x / part.width),
		top: percent(-part.y / part.height),
	};
}

/** The sides of a crop that a handle moves. A corner moves two sides. */
export type CropHandle = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

export const CROP_HANDLES: readonly CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

/** A crop after the whole frame moved by a part of the image. The frame stays in the image, with its size. */
export function movedCrop(crop: DocImageCrop, dx: number, dy: number): DocImageCrop {
	return {
		...crop,
		x: clamp(crop.x + dx, 0, 1 - crop.width),
		y: clamp(crop.y + dy, 0, 1 - crop.height),
	};
}

/**
 * A crop after a handle moved by a part of the image. The opposite side stays. The crop stays in the
 * image, and no side is shorter than the limit of the server.
 */
export function resizedCrop(crop: DocImageCrop, handle: CropHandle, dx: number, dy: number): DocImageCrop {
	const min = DOC_LIMITS.imageMinCrop;
	let left = crop.x;
	let top = crop.y;
	let right = crop.x + crop.width;
	let bottom = crop.y + crop.height;
	if (handle.includes("w")) left = clamp(left + dx, 0, right - min);
	if (handle.includes("e")) right = clamp(right + dx, left + min, 1);
	if (handle.includes("n")) top = clamp(top + dy, 0, bottom - min);
	if (handle.includes("s")) bottom = clamp(bottom + dy, top + min, 1);
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The shown width after a change of the crop, so the picture keeps its scale: a narrower crop makes a
 * narrower image, and the part that stays has the same size on the page.
 */
export function widthAfterCrop(width: number, before: DocImageCrop | null, after: DocImageCrop | null): number {
	const scaled = (width * (after ?? FULL_CROP).width) / (before ?? FULL_CROP).width;
	return Math.round(clamp(scaled, MIN_SHOWN_WIDTH, DOC_LIMITS.imageMaxWidth));
}

/** The sizes of the size control, as a part of the width of the text. */
export const SIZE_PRESETS = [
	{ value: "25", label: "25%", part: 0.25 },
	{ value: "50", label: "50%", part: 0.5 },
	{ value: "75", label: "75%", part: 0.75 },
	{ value: "100", label: "100%", part: 1 },
] as const;

export type SizePreset = (typeof SIZE_PRESETS)[number]["value"] | "original";

/** The width of a size of the size control. `original` is the width of the shown part of the file. */
export function presetWidth(preset: SizePreset, natural: Size, crop: DocImageCrop | null, available: number): number {
	if (preset === "original") return fitWidth(natural, crop, available);
	const part = SIZE_PRESETS.find((entry) => entry.value === preset)?.part ?? 1;
	return Math.round(clamp(available * part, MIN_SHOWN_WIDTH, DOC_LIMITS.imageMaxWidth));
}

/** The size of the size control that an image has now, or null for a size from a handle. */
export function presetOf(
	width: number | null,
	natural: Size,
	crop: DocImageCrop | null,
	available: number,
): SizePreset | null {
	if (width === null) return "original";
	for (const entry of SIZE_PRESETS) {
		if (Math.abs(presetWidth(entry.value, natural, crop, available) - width) <= 1) return entry.value;
	}
	return Math.abs(presetWidth("original", natural, crop, available) - width) <= 1 ? "original" : null;
}

/** How the text goes around an image: the three groups of the layouts. */
export type WrapMode = "inline" | "wrap" | "break";
export type Side = "left" | "center" | "right";

export function wrapModeOf(layout: DocImageLayout): WrapMode {
	if (layout === "inline") return "inline";
	return layout.startsWith("wrap") ? "wrap" : "break";
}

/** The side of an image that is not in the line, or null. */
export function sideOf(layout: DocImageLayout): Side | null {
	if (layout === "inline") return null;
	return layout.slice(layout.indexOf("_") + 1) as Side;
}

/** The sides that a mode can have. The text cannot go around an image in the center. */
export function sidesOf(mode: WrapMode): readonly Side[] {
	if (mode === "inline") return [];
	return mode === "wrap" ? ["left", "right"] : ["left", "center", "right"];
}

/** The layout for a mode. It keeps the side of the image when the mode can have that side. */
export function layoutForMode(mode: WrapMode, current: DocImageLayout): DocImageLayout {
	if (mode === "inline") return "inline";
	const side = sideOf(current);
	if (mode === "wrap") return side === "right" ? "wrap_right" : "wrap_left";
	return side === null ? "break_center" : `break_${side}`;
}

/** The layout for a side, in the mode of the image. Null when the mode cannot have the side. */
export function layoutForSide(side: Side, current: DocImageLayout): DocImageLayout | null {
	const mode = wrapModeOf(current);
	if (!sidesOf(mode).includes(side)) return null;
	return `${mode}_${side}` as DocImageLayout;
}
