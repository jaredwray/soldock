import type { DocImageLayout } from "@soldock/contracts";
import { type KeyboardEvent, useRef, useState } from "react";
import { Icon, type IconName } from "../../lib/icons.tsx";
import { Select } from "../../lib/Select.tsx";
import type { SelectedImage } from "./imageCommands.ts";
import {
	layoutForMode,
	layoutForSide,
	presetOf,
	presetWidth,
	SIZE_PRESETS,
	type Side,
	type Size,
	type SizePreset,
	sideOf,
	sidesOf,
	type WrapMode,
	wrapModeOf,
} from "./imageModel.ts";
import type { ImageAttrs } from "./schema.ts";

const MODES: readonly { mode: WrapMode; label: string; hint: string }[] = [
	{ mode: "inline", label: "In line", hint: "The image is in the line of text, as a character" },
	{ mode: "wrap", label: "Wrap text", hint: "The image is at one side, and the text goes around it" },
	{ mode: "break", label: "Break text", hint: "The image is on its own line, between the text" },
];

const SIDES: readonly { side: Side; label: string; icon: IconName }[] = [
	{ side: "left", label: "Image at the left", icon: "alignLeft" },
	{ side: "center", label: "Image in the center", icon: "alignCenter" },
	{ side: "right", label: "Image at the right", icon: "alignRight" },
];

const SIZE_OPTIONS: readonly { value: SizePreset; label: string }[] = [
	...SIZE_PRESETS.map((entry) => ({ value: entry.value, label: `${entry.label} of the text width` })),
	{ value: "original", label: "Original size" },
];

interface ImageToolbarProps {
	/** The id of the text area that the toolbar controls. */
	editorId: string;
	image: SelectedImage;
	/** The pixels of the file, or null while the editor does not have them. */
	natural: Size | null;
	/** The width of the text of the doc, in CSS pixels. */
	available: number;
	/** Undo and Redo are the first buttons of each toolbar of the editor. `run` is null when the button can do nothing. */
	history: readonly { name: string; icon: IconName; keys: string; hint: string; run: (() => void) | null }[];
	onAttrs: (patch: Partial<ImageAttrs>) => void;
	onCrop: () => void;
	onAlt: () => void;
	onCaption: () => void;
	onRemove: () => void;
}

/**
 * The toolbar for a selected image. It takes the place of the formatting toolbar, so the page does not
 * move when a person selects an image. The buttons are one tab stop: the arrow keys, Home and End move
 * between them. The size control is a second tab stop, because it uses the arrow keys itself.
 */
export function ImageToolbar({
	editorId,
	image,
	natural,
	available,
	history,
	onAttrs,
	onCrop,
	onAlt,
	onCaption,
	onRemove,
}: ImageToolbarProps) {
	const barRef = useRef<HTMLDivElement>(null);
	const [focusIndex, setFocusIndex] = useState(0);
	const { attrs } = image;
	const mode = wrapModeOf(attrs.layout);
	const side = sideOf(attrs.layout);
	const preset = natural ? presetOf(attrs.width, natural, attrs.crop, available) : null;

	function buttons(): HTMLElement[] {
		return [...(barRef.current?.querySelectorAll<HTMLElement>(":scope > button") ?? [])];
	}

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.target instanceof HTMLElement && event.target.getAttribute("role") === "combobox") return;
		const all = buttons();
		const last = all.length - 1;
		const index = Math.min(focusIndex, last);
		const moves: Record<string, number> = {
			ArrowRight: index >= last ? 0 : index + 1,
			ArrowLeft: index <= 0 ? last : index - 1,
			Home: 0,
			End: last,
		};
		const next = moves[event.key];
		if (next === undefined) return;
		event.preventDefault();
		setFocusIndex(next);
		all[next]?.focus();
	}

	/** The tab stop and the mouse rules of the next button, in the order of the toolbar. */
	let order = 0;
	const stop = () => {
		const index = order++;
		return {
			tabIndex: index === focusIndex ? 0 : -1,
			onFocus: () => setFocusIndex(index),
			// A click must not take the focus, so the image stays selected in the editor.
			onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault(),
		};
	};

	function setLayout(layout: DocImageLayout | null) {
		if (layout !== null && layout !== attrs.layout) onAttrs({ layout });
	}

	return (
		<div
			ref={barRef}
			role="toolbar"
			aria-label="Image"
			aria-controls={editorId}
			className="editor-toolbar doc-image-toolbar"
			onKeyDown={onKeyDown}
		>
			{history.map((tool) => (
				<button
					key={tool.name}
					type="button"
					className="icon-button icon-button-small format-button"
					aria-label={tool.name}
					aria-keyshortcuts={tool.keys}
					aria-disabled={tool.run ? undefined : true}
					title={`${tool.name} (${tool.hint})`}
					{...stop()}
					onClick={() => tool.run?.()}
				>
					<Icon name={tool.icon} size={18} />
				</button>
			))}
			{MODES.map((entry, index) => (
				<button
					key={entry.mode}
					type="button"
					className={`format-button doc-image-tool${index === 0 ? " format-group-start" : ""}`}
					aria-pressed={mode === entry.mode}
					title={entry.hint}
					{...stop()}
					onClick={() => setLayout(layoutForMode(entry.mode, attrs.layout))}
				>
					{entry.label}
				</button>
			))}
			{SIDES.map((entry, index) => {
				const enabled = sidesOf(mode).includes(entry.side);
				return (
					<button
						key={entry.side}
						type="button"
						className={`icon-button icon-button-small format-button${index === 0 ? " format-group-start" : ""}`}
						aria-label={entry.label}
						aria-pressed={side === entry.side}
						// Not the disabled attribute: the button then stays a tab stop of the toolbar.
						aria-disabled={enabled ? undefined : true}
						title={enabled ? entry.label : `${entry.label} (not for this layout)`}
						{...stop()}
						onClick={() => setLayout(layoutForSide(entry.side, attrs.layout))}
					>
						<Icon name={entry.icon} size={18} />
					</button>
				);
			})}
			<Select
				className="doc-block-type doc-image-size-select"
				label="Size of the image"
				value={preset ?? ""}
				options={SIZE_OPTIONS}
				placeholder={attrs.width === null ? "Size" : `${attrs.width} pixels wide`}
				disabled={natural === null}
				onChange={(value) => {
					if (natural && value !== "") onAttrs({ width: presetWidth(value, natural, attrs.crop, available) });
				}}
			/>
			<button
				type="button"
				className="format-button doc-image-tool format-group-start"
				{...stop()}
				aria-disabled={natural ? undefined : true}
				onClick={() => natural && onCrop()}
			>
				Crop
			</button>
			<button type="button" className="format-button doc-image-tool" {...stop()} onClick={onAlt}>
				Alt text
			</button>
			<button
				type="button"
				className="format-button doc-image-tool"
				aria-pressed={attrs.caption !== null}
				{...stop()}
				onClick={onCaption}
			>
				Caption
			</button>
			<button
				type="button"
				className="icon-button icon-button-small format-button format-group-start"
				aria-label="Remove image"
				title="Remove image (Delete)"
				{...stop()}
				onClick={onRemove}
			>
				<Icon name="trash" size={18} />
			</button>
		</div>
	);
}
