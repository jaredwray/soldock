import "../drive/drive.css";
import { DOC_IMAGE_TYPES, DOC_LIMITS, type DocImageCrop, DRIVE_LIMITS, type DriveItem } from "@asterra/contracts";
import {
	type FormEvent,
	type KeyboardEvent,
	type PointerEvent,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { formatBytes } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useSession } from "../auth/session.tsx";
import { SHARED_DRIVE_ICON, spaceInput } from "../drive/model.ts";
import { CROP_HANDLES, type CropHandle, FULL_CROP, movedCrop, resizedCrop, type Size } from "./imageModel.ts";
import { imageCrop, importableSrc, oneLine } from "./schema.ts";

// The dialogs of the images of a doc: the alt text, the crop, an image from a web address, and an
// image from Drive.

interface AltTextDialogProps {
	alt: string;
	onApply: (alt: string) => void;
	onClose: () => void;
}

/** The text for a person who cannot see the image. A screen reader reads it. */
export function AltTextDialog({ alt, onApply, onClose }: AltTextDialogProps) {
	const [text, setText] = useState(alt);
	const id = useId();

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		event.stopPropagation();
		onApply(oneLine(text, DOC_LIMITS.imageAltChars));
	}

	return (
		<Dialog title="Alt text" onClose={onClose} className="dialog-small">
			<form onSubmit={submit} noValidate>
				<div className="dialog-body">
					<div className="field">
						<label htmlFor={id} className="field-label">
							Description of the image
						</label>
						<textarea
							id={id}
							className="input doc-alt-input"
							rows={3}
							maxLength={DOC_LIMITS.imageAltChars}
							value={text}
							onChange={(event) => setText(event.target.value)}
							aria-describedby={`${id}-hint`}
							data-autofocus
						/>
						<p id={`${id}-hint`} className="field-hint">
							A screen reader reads this text to a person who cannot see the image.
						</p>
					</div>
				</div>
				<div className="dialog-actions">
					<button type="button" className="button" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="button button-primary">
						Apply
					</button>
				</div>
			</form>
		</Dialog>
	);
}

interface ImageUrlDialogProps {
	onApply: (url: string) => void;
	onClose: () => void;
}

/** An image from a web address. The server downloads it one time, and the doc keeps its own copy. */
export function ImageUrlDialog({ onApply, onClose }: ImageUrlDialogProps) {
	const [address, setAddress] = useState("");
	const [error, setError] = useState<string | null>(null);
	const ids = { address: useId(), hint: useId(), error: useId() };

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		event.stopPropagation();
		const value = address.trim();
		const src = /^https:\/\//i.test(value) ? importableSrc(value) : null;
		if (src === null) {
			setError("Enter the https address of an image, for example https://example.com/photo.png.");
			return;
		}
		onApply(src);
	}

	return (
		<Dialog title="Image from a web address" onClose={onClose} className="dialog-small">
			<form onSubmit={submit} noValidate>
				<div className="dialog-body">
					<div className="field">
						<label htmlFor={ids.address} className="field-label">
							Address of the image
						</label>
						<input
							id={ids.address}
							className="input"
							type="text"
							inputMode="url"
							autoComplete="off"
							spellCheck={false}
							placeholder="https://"
							value={address}
							onChange={(event) => {
								setAddress(event.target.value);
								setError(null);
							}}
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? ids.error : ids.hint}
							data-autofocus
						/>
						{error ? (
							<p id={ids.error} className="field-error" role="alert">
								{error}
							</p>
						) : (
							<p id={ids.hint} className="field-hint">
								Asterra downloads the image one time. The doc keeps its own copy.
							</p>
						)}
					</div>
				</div>
				<div className="dialog-actions">
					<button type="button" className="button" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="button button-primary">
						Insert
					</button>
				</div>
			</form>
		</Dialog>
	);
}

const HANDLE_NAMES: Record<CropHandle, string> = {
	nw: "Top left corner",
	n: "Top side",
	ne: "Top right corner",
	e: "Right side",
	se: "Bottom right corner",
	s: "Bottom side",
	sw: "Bottom left corner",
	w: "Left side",
};

/** The part of the image that one press of an arrow key moves a side: 1%, or 10% with Shift. */
function keyStep(event: KeyboardEvent): { dx: number; dy: number } | null {
	const step = event.shiftKey ? 0.1 : 0.01;
	switch (event.key) {
		case "ArrowLeft":
			return { dx: -step, dy: 0 };
		case "ArrowRight":
			return { dx: step, dy: 0 };
		case "ArrowUp":
			return { dx: 0, dy: -step };
		case "ArrowDown":
			return { dx: 0, dy: step };
		default:
			return null;
	}
}

interface CropDialogProps {
	/** The `blob:` address of the whole image. */
	load: () => Promise<string>;
	/** The pixels of the file. */
	natural: Size;
	crop: DocImageCrop | null;
	/** Called with the new crop, or null for the whole image. */
	onApply: (crop: DocImageCrop | null) => void;
	onClose: () => void;
}

/**
 * Selects the part of an image that shows. The doc keeps the whole file, so a later crop can show
 * more. A person drags the frame or its handles. With the keyboard, each handle and the frame are
 * buttons: the arrow keys move them by 1% of the image, or by 10% with Shift.
 */
export function CropDialog({ load, natural, crop, onApply, onClose }: CropDialogProps) {
	const [url, setUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [frame, setFrame] = useState<DocImageCrop>(crop ?? FULL_CROP);
	const stageRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{ x: number; y: number; start: DocImageCrop; handle: CropHandle | "move" } | null>(null);
	const [loadOnce] = useState(() => load);

	useEffect(() => {
		let active = true;
		loadOnce().then(
			(address) => active && setUrl(address),
			(caught) => active && setError(errorMessage(caught)),
		);
		return () => {
			active = false;
		};
	}, [loadOnce]);

	function change(start: DocImageCrop, handle: CropHandle | "move", dx: number, dy: number) {
		setFrame(handle === "move" ? movedCrop(start, dx, dy) : resizedCrop(start, handle, dx, dy));
	}

	function onPointerDown(event: PointerEvent<HTMLElement>, handle: CropHandle | "move") {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		event.currentTarget.focus();
		dragRef.current = { x: event.clientX, y: event.clientY, start: frame, handle };
	}

	function onPointerMove(event: PointerEvent<HTMLElement>) {
		const drag = dragRef.current;
		const stage = stageRef.current?.getBoundingClientRect();
		if (!drag || !stage || stage.width === 0 || stage.height === 0) return;
		change(drag.start, drag.handle, (event.clientX - drag.x) / stage.width, (event.clientY - drag.y) / stage.height);
	}

	function onPointerUp() {
		dragRef.current = null;
	}

	function onKeyDown(event: KeyboardEvent<HTMLElement>, handle: CropHandle | "move") {
		const step = keyStep(event);
		if (!step) return;
		event.preventDefault();
		change(frame, handle, step.dx, step.dy);
	}

	const percent = (value: number) => `${value * 100}%`;
	// The shade over the part that does not show: the whole stage, with a hole for the frame.
	const [left, top] = [percent(frame.x), percent(frame.y)];
	const [right, bottom] = [percent(frame.x + frame.width), percent(frame.y + frame.height)];
	const shade = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left} ${top}, ${left} ${bottom}, ${right} ${bottom}, ${right} ${top}, ${left} ${top})`;
	const pixels = `${Math.round(frame.width * natural.width)} × ${Math.round(frame.height * natural.height)} pixels`;
	const whole = imageCrop(frame) === null;

	return (
		<Dialog title="Crop image" onClose={onClose} className="dialog-wide">
			<div className="dialog-body">
				{error && (
					<p className="form-error" role="alert">
						The image did not load. {error}
					</p>
				)}
				{!error && url === null && (
					<p className="drive-picker-state" role="status">
						<span className="spinner spinner-small" aria-hidden="true" /> Loading the image…
					</p>
				)}
				{url !== null && (
					<div className="doc-crop">
						<div className="doc-crop-stage" ref={stageRef}>
							<img className="doc-crop-picture" src={url} alt="" draggable={false} />
							<div className="doc-crop-shade" style={{ clipPath: shade }} />
							{/* biome-ignore lint/a11y/useSemanticElements: the frame holds the handles, which are buttons, so it cannot be a button. */}
							<div
								className="doc-crop-frame"
								role="button"
								tabIndex={0}
								aria-label="The part of the image that shows. Use the arrow keys to move it."
								style={{
									left: percent(frame.x),
									top: percent(frame.y),
									width: percent(frame.width),
									height: percent(frame.height),
								}}
								onPointerDown={(event) => onPointerDown(event, "move")}
								onPointerMove={onPointerMove}
								onPointerUp={onPointerUp}
								onPointerCancel={onPointerUp}
								onKeyDown={(event) => {
									if (event.target === event.currentTarget) onKeyDown(event, "move");
								}}
								data-autofocus
							>
								{CROP_HANDLES.map((handle) => (
									<button
										key={handle}
										type="button"
										className={`doc-crop-handle doc-crop-handle-${handle}`}
										aria-label={`${HANDLE_NAMES[handle]}. Use the arrow keys to move it.`}
										onPointerDown={(event) => onPointerDown(event, handle)}
										onPointerMove={onPointerMove}
										onPointerUp={onPointerUp}
										onPointerCancel={onPointerUp}
										onKeyDown={(event) => onKeyDown(event, handle)}
									/>
								))}
							</div>
						</div>
						<p className="field-hint doc-crop-size" aria-live="polite">
							{whole ? "The whole image shows." : `${pixels} of the image show.`}
						</p>
					</div>
				)}
			</div>
			<div className="dialog-actions">
				<button type="button" className="button doc-crop-reset" onClick={() => setFrame(FULL_CROP)} disabled={whole}>
					Show the whole image
				</button>
				<button type="button" className="button" onClick={onClose}>
					Cancel
				</button>
				<button
					type="button"
					className="button button-primary"
					onClick={() => onApply(imageCrop(frame))}
					disabled={url === null}
				>
					Apply
				</button>
			</div>
		</Dialog>
	);
}

const IMAGE_TYPES: readonly string[] = DOC_IMAGE_TYPES;

/** True for a file of Drive that can be an image of a doc. The server reads the bytes again. */
export function isDriveImage(item: Pick<DriveItem, "kind" | "mime_type" | "size">): boolean {
	const type = (item.mime_type ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
	return item.kind === "file" && IMAGE_TYPES.includes(type) && item.size <= DOC_LIMITS.imageBytes;
}

interface PickerDrive {
	spaceId: string;
	name: string;
	shared: boolean;
}

type ListState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "ready"; items: DriveItem[]; nextCursor: string | null };

interface DriveImageDialogProps {
	onPick: (items: DriveItem[]) => void;
	onClose: () => void;
}

/**
 * Selects image files of Drive for a doc. The dialog starts in My Drive. "Drives" shows My Drive and
 * the shared drives of the person. In a drive, the dialog shows the folders and the image files of one
 * folder. The doc gets a copy of each selected image.
 */
export function DriveImageDialog({ onPick, onClose }: DriveImageDialogProps) {
	const ownSpaceId = useSession().whoami.principal.id;
	const [myDrive] = useState<PickerDrive>(() => ({ spaceId: ownSpaceId, name: "My Drive", shared: false }));
	// The drive on screen. Null for the list of the drives.
	const [drive, setDrive] = useState<PickerDrive | null>(myDrive);
	const [drives, setDrives] = useState<
		{ status: "loading" } | { status: "error"; error: string } | { status: "ready"; drives: PickerDrive[] }
	>({ status: "loading" });
	const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
	const [list, setList] = useState<ListState>({ status: "loading" });
	const [picked, setPicked] = useState<DriveItem[]>([]);
	const requestRef = useRef(0);
	const currentId = trail[trail.length - 1]?.id ?? null;
	const driveId = drive?.spaceId ?? null;

	const load = useCallback(
		async (spaceId: string, parentId: string | null, cursor: string | null) => {
			const request = ++requestRef.current;
			if (cursor === null) setList({ status: "loading" });
			try {
				const result = await api.call("drive.list_items", {
					view: "folder",
					...spaceInput(spaceId, ownSpaceId),
					...(parentId ? { parent_id: parentId } : {}),
					...(cursor ? { cursor } : {}),
					limit: DRIVE_LIMITS.pageSize,
				});
				if (request !== requestRef.current) return;
				const shown = result.items.filter((item) => item.kind === "folder" || isDriveImage(item));
				setList((previous) => ({
					status: "ready",
					items: cursor !== null && previous.status === "ready" ? [...previous.items, ...shown] : shown,
					nextCursor: result.next_cursor,
				}));
			} catch (caught) {
				if (request !== requestRef.current) return;
				setList({ status: "error", error: errorMessage(caught) });
			}
		},
		[ownSpaceId],
	);

	useEffect(() => {
		if (driveId !== null) void load(driveId, currentId, null);
	}, [load, driveId, currentId]);

	const loadDrives = useCallback(async () => {
		setDrives({ status: "loading" });
		try {
			const found: PickerDrive[] = [];
			let cursor: string | undefined;
			do {
				const page = await api.call("drive.list_shared_drives", { ...(cursor ? { cursor } : {}) });
				for (const entry of page.shared_drives) found.push({ spaceId: entry.id, name: entry.name, shared: true });
				cursor = page.next_cursor ?? undefined;
			} while (cursor);
			setDrives({ status: "ready", drives: found });
		} catch (caught) {
			setDrives({ status: "error", error: errorMessage(caught) });
		}
	}, []);

	function openDrives() {
		setDrive(null);
		setTrail([]);
		void loadDrives();
	}

	function toggle(item: DriveItem) {
		setPicked((current) =>
			current.some((entry) => entry.id === item.id)
				? current.filter((entry) => entry.id !== item.id)
				: [...current, item],
		);
	}

	const count = picked.length;

	return (
		<Dialog title="Image from Drive" onClose={onClose}>
			<div className="dialog-body">
				<nav aria-label="Folder path" className="drive-picker-path">
					<button type="button" className="link-button" disabled={drive === null} onClick={openDrives}>
						Drives
					</button>
					{drive !== null && (
						<>
							<Icon name="chevronRight" size={14} />
							<button type="button" className="link-button" disabled={trail.length === 0} onClick={() => setTrail([])}>
								{drive.name}
							</button>
						</>
					)}
					{trail.map((entry, index) => (
						<span key={entry.id} className="drive-picker-crumb">
							<Icon name="chevronRight" size={14} />
							<button
								type="button"
								className="link-button"
								disabled={index === trail.length - 1}
								onClick={() => setTrail(trail.slice(0, index + 1))}
							>
								{entry.name}
							</button>
						</span>
					))}
				</nav>
				<div className="drive-picker" aria-live="polite">
					{drive === null && (
						<ul className="drive-picker-list" aria-label="Drives">
							{[myDrive, ...(drives.status === "ready" ? drives.drives : [])].map((target) => (
								<li key={target.spaceId}>
									<button type="button" className="drive-picker-item" onClick={() => setDrive(target)}>
										<Icon name={target.shared ? SHARED_DRIVE_ICON : "drive"} />
										<span className="drive-picker-name">{target.name}</span>
										<Icon name="chevronRight" size={16} />
									</button>
								</li>
							))}
						</ul>
					)}
					{drive === null && drives.status === "loading" && (
						<p className="drive-picker-state" role="status">
							<span className="spinner spinner-small" aria-hidden="true" /> Loading the shared drives…
						</p>
					)}
					{drive === null && drives.status === "error" && (
						<p className="drive-picker-state" role="alert">
							The shared drives did not load. {drives.error}{" "}
							<button type="button" className="link-button" onClick={() => void loadDrives()}>
								Try again
							</button>
						</p>
					)}
					{drive !== null && list.status === "loading" && (
						<p className="drive-picker-state" role="status">
							<span className="spinner spinner-small" aria-hidden="true" /> Loading…
						</p>
					)}
					{drive !== null && list.status === "error" && (
						<p className="drive-picker-state" role="alert">
							The folder did not load. {list.error}{" "}
							<button type="button" className="link-button" onClick={() => void load(drive.spaceId, currentId, null)}>
								Try again
							</button>
						</p>
					)}
					{drive !== null && list.status === "ready" && list.items.length === 0 && (
						<p className="drive-picker-state">This folder has no folders and no PNG, JPEG, GIF or WebP images.</p>
					)}
					{drive !== null && list.status === "ready" && list.items.length > 0 && (
						<ul className="drive-picker-list">
							{list.items.map((item) =>
								item.kind === "folder" ? (
									<li key={item.id}>
										<button
											type="button"
											className="drive-picker-item"
											onClick={() => setTrail([...trail, { id: item.id, name: item.name }])}
										>
											<Icon name="folder" />
											<span className="drive-picker-name">{item.name}</span>
											<Icon name="chevronRight" size={16} />
										</button>
									</li>
								) : (
									<li key={item.id}>
										<button
											type="button"
											className="drive-picker-item doc-picker-image"
											aria-pressed={picked.some((entry) => entry.id === item.id)}
											onClick={() => toggle(item)}
										>
											<Icon name="image" />
											<span className="drive-picker-name">{item.name}</span>
											<span className="muted drive-picker-note">{formatBytes(item.size)}</span>
											<span className="doc-picker-check" aria-hidden="true">
												<Icon name="check" size={16} />
											</span>
										</button>
									</li>
								),
							)}
						</ul>
					)}
					{drive !== null && list.status === "ready" && list.nextCursor !== null && (
						<p className="drive-picker-state">
							<button
								type="button"
								className="button button-small"
								onClick={() => void load(drive.spaceId, currentId, list.nextCursor)}
							>
								More
							</button>
						</p>
					)}
				</div>
			</div>
			<div className="dialog-actions">
				<button type="button" className="button" onClick={onClose} data-autofocus>
					Cancel
				</button>
				<button type="button" className="button button-primary" disabled={count === 0} onClick={() => onPick(picked)}>
					{count <= 1 ? "Insert image" : `Insert ${count} images`}
				</button>
			</div>
		</Dialog>
	);
}
