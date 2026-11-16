import { DRIVE_LIMITS, type DriveItem } from "@soldock/contracts";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { plural } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useSession } from "../auth/session.tsx";
import {
	type CreateTarget,
	idBatches,
	kindName,
	type MoveSummary,
	type MoveTarget,
	moveAcrossRefusal,
	moveConfirmText,
	moveItemsInput,
	moveSummary,
	moveToDriveInput,
	SHARED_DRIVE_ICON,
	spaceInput,
} from "./model.ts";

interface NameDialogProps {
	title: string;
	label: string;
	initial: string;
	submitLabel: string;
	busyLabel: string;
	/** Sends the name. The dialog stays open and shows the error if it throws. */
	onSubmit: (name: string) => Promise<void>;
	onClose: () => void;
}

/** A dialog with one name field: for a new folder and for a rename. */
function NameDialog({ title, label, initial, submitLabel, busyLabel, onSubmit, onClose }: NameDialogProps) {
	const [name, setName] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputId = useId();

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) {
			setError("Enter a name.");
			return;
		}
		if (/[\\/]/.test(trimmed)) {
			setError("A name cannot contain a slash or a backslash.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await onSubmit(trimmed);
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog title={title} onClose={() => !busy && onClose()} className="dialog-small">
			<form onSubmit={submit} noValidate>
				<div className="dialog-body">
					<label htmlFor={inputId} className="field-label">
						{label}
					</label>
					<input
						id={inputId}
						className="input"
						value={name}
						maxLength={DRIVE_LIMITS.nameChars}
						autoComplete="off"
						onChange={(event) => setName(event.target.value)}
						onFocus={(event) => event.currentTarget.select()}
						aria-invalid={error ? true : undefined}
						data-autofocus
					/>
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<div className="dialog-actions">
					<button type="button" className="button" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" className="button button-primary" disabled={busy}>
						{busy ? busyLabel : submitLabel}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

export function NewFolderDialog({
	target,
	onClose,
	onCreated,
}: {
	target: CreateTarget;
	onClose: () => void;
	onCreated: (item: DriveItem) => void;
}) {
	// One key for the dialog, so a retry after a lost answer does not make a second folder.
	const [idempotencyKey] = useState(() => crypto.randomUUID());
	return (
		<NameDialog
			title="New folder"
			label="Folder name"
			initial="Untitled folder"
			submitLabel="Create"
			busyLabel="Creating…"
			onClose={onClose}
			onSubmit={async (name) => {
				const result = await api.call("drive.create_folder", { ...target, name, idempotency_key: idempotencyKey });
				onCreated(result.item);
			}}
		/>
	);
}

export function RenameDialog({
	item,
	onClose,
	onRenamed,
}: {
	item: DriveItem;
	onClose: () => void;
	onRenamed: (item: DriveItem) => void;
}) {
	const ownSpaceId = useSession().whoami.principal.id;
	return (
		<NameDialog
			title={`Rename ${kindName(item).toLowerCase()}`}
			label="Name"
			initial={item.name}
			submitLabel="Rename"
			busyLabel="Renaming…"
			onClose={onClose}
			onSubmit={async (name) => {
				if (name === item.name) {
					onClose();
					return;
				}
				const result = await api.call("drive.rename_item", {
					...spaceInput(item.space_id, ownSpaceId),
					item_id: item.id,
					name,
				});
				onRenamed(result.item);
			}}
		/>
	);
}

interface PickerState {
	status: "loading" | "ready" | "error";
	folders: DriveItem[];
	nextCursor: string | null;
	error: string | null;
}

const PICKER_LOADING: PickerState = { status: "loading", folders: [], nextCursor: null, error: null };

/** `“Report.pdf”` for one item, and `3 items` for more. */
export function describeItems(items: readonly Pick<DriveItem, "name">[]): string {
	const first = items[0];
	return items.length === 1 && first ? `“${first.name}”` : plural(items.length, "item");
}

/** The place that a move to a different drive puts the items in. */
export interface MoveDestination {
	drive: MoveTarget;
	/** The folder of the drive, or null for its root. */
	folder: { id: string; name: string } | null;
}

/**
 * Moves items to a place that the person selects. The dialog starts in the drive that holds the
 * items. "Drives" shows each drive that can get them: My Drive and the shared drives where the person
 * is an editor or a manager. In a drive, the dialog shows the folders of one level, and a click on a
 * folder opens it.
 *
 * A move in the same drive runs here (`drive.move_items`). The server refuses a move of a folder into
 * itself or into a folder under it, and the dialog shows that error. For a different drive, the
 * dialog calls `onAcross`: that move needs a confirmation.
 *
 * `drives` is the state of the list of the shared drives. While the list loads, and after it did not
 * load, `targets` can be without some drives. The dialog then says so.
 */
export function MoveDialog({
	items,
	targets,
	drives,
	onClose,
	onMoved,
	onPartial,
	onAcross,
}: {
	items: readonly DriveItem[];
	/** The drives that can get the items. The drive that holds them is one of these. */
	targets: readonly MoveTarget[];
	drives: { status: "loading" | "ready" | "error"; error: string | null; retry: () => void };
	onClose: () => void;
	onMoved: (destination: string) => void;
	/** After a move that failed when a part of the items moved. The list on the page is then old. */
	onPartial: () => void;
	onAcross: (destination: MoveDestination) => void;
}) {
	const ownSpaceId = useSession().whoami.principal.id;
	const sourceId = items[0]?.space_id ?? ownSpaceId;
	// The drive on screen. Null for the list of the drives.
	const [drive, setDrive] = useState<MoveTarget | null>(
		() => targets.find((target) => target.spaceId === sourceId) ?? null,
	);
	// The folders from the root of the drive to the folder on screen. Empty for the root.
	const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
	const [state, setState] = useState<PickerState>(PICKER_LOADING);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const current = trail[trail.length - 1] ?? null;
	const currentId = current?.id ?? null;
	const driveId = drive?.spaceId ?? null;
	const moving = new Set(items.map((item) => item.id));
	const across = driveId !== null && driveId !== sourceId;
	const alreadyThere = !across && items.every((item) => (item.parent_id ?? null) === currentId);
	// A move to a different drive is one call, so it takes at most 100 items.
	const acrossRefusal = across ? moveAcrossRefusal(items.length) : null;
	const destination = current?.name ?? drive?.name ?? "";

	// Only the answer of the last request shows, so a slow answer for one folder cannot fill a different one.
	const requestRef = useRef(0);

	const load = useCallback(
		async (spaceId: string, parentId: string | null, cursor: string | null) => {
			const request = ++requestRef.current;
			if (cursor === null) setState(PICKER_LOADING);
			try {
				const result = await api.call("drive.list_items", {
					view: "folder",
					kind: "folder",
					...spaceInput(spaceId, ownSpaceId),
					...(parentId ? { parent_id: parentId } : {}),
					...(cursor ? { cursor } : {}),
					limit: DRIVE_LIMITS.pageSize,
				});
				if (request !== requestRef.current) return;
				setState((previous) => ({
					status: "ready",
					folders: cursor === null ? result.items : [...previous.folders, ...result.items],
					nextCursor: result.next_cursor,
					error: null,
				}));
			} catch (caught) {
				if (request !== requestRef.current) return;
				setState({ ...PICKER_LOADING, status: "error", error: errorMessage(caught) });
			}
		},
		[ownSpaceId],
	);

	useEffect(() => {
		if (driveId !== null) void load(driveId, currentId, null);
	}, [load, driveId, currentId]);

	function openDrive(next: MoveTarget | null) {
		setDrive(next);
		setTrail([]);
		setError(null);
	}

	async function move() {
		if (drive === null) return;
		if (across) return onAcross({ drive, folder: current });
		setBusy(true);
		setError(null);
		let moved = 0;
		try {
			for (const batch of idBatches(items.map((item) => item.id))) {
				await api.call("drive.move_items", moveItemsInput(sourceId, ownSpaceId, batch, currentId));
				moved += batch.length;
			}
			onMoved(destination);
		} catch (caught) {
			// Each call moves its items or none. A call that follows a good call can fail.
			if (moved > 0) onPartial();
			const message = errorMessage(caught);
			setError(moved > 0 ? `${moved} of ${items.length} items moved to ${destination}. ${message}` : message);
			setBusy(false);
		}
	}

	return (
		<Dialog title={`Move ${describeItems(items)}`} onClose={() => !busy && onClose()}>
			<div className="dialog-body">
				<nav aria-label="Folder path" className="drive-picker-path">
					{targets.length > 1 && (
						<>
							<button type="button" className="link-button" disabled={drive === null} onClick={() => openDrive(null)}>
								Drives
							</button>
							{drive !== null && <Icon name="chevronRight" size={14} />}
						</>
					)}
					{drive !== null && (
						<button type="button" className="link-button" disabled={trail.length === 0} onClick={() => setTrail([])}>
							{drive.name}
						</button>
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
				{drives.status === "loading" && (
					<p className="drive-picker-state" role="status">
						<span className="spinner spinner-small" aria-hidden="true" /> Loading the shared drives…
					</p>
				)}
				{drives.status === "error" && (
					<p className="drive-picker-state" role="alert">
						The shared drives did not load. {drives.error}{" "}
						<button type="button" className="link-button" onClick={drives.retry}>
							Try again
						</button>
					</p>
				)}
				<div className="drive-picker" aria-live="polite">
					{drive === null && (
						<ul className="drive-picker-list" aria-label="Drives">
							{targets.map((target) => (
								<li key={target.spaceId}>
									<button type="button" className="drive-picker-item" onClick={() => openDrive(target)}>
										<Icon name={target.shared ? SHARED_DRIVE_ICON : "drive"} />
										<span className="drive-picker-name">{target.name}</span>
										{target.spaceId === sourceId && <span className="muted drive-picker-note">The items are here</span>}
										<Icon name="chevronRight" size={16} />
									</button>
								</li>
							))}
						</ul>
					)}
					{drive !== null && state.status === "loading" && (
						<p className="drive-picker-state">
							<span className="spinner spinner-small" aria-hidden="true" /> Loading folders…
						</p>
					)}
					{drive !== null && state.status === "error" && (
						<p className="drive-picker-state" role="alert">
							The folders did not load. {state.error}{" "}
							<button type="button" className="link-button" onClick={() => void load(drive.spaceId, currentId, null)}>
								Try again
							</button>
						</p>
					)}
					{drive !== null && state.status === "ready" && state.folders.length === 0 && (
						<p className="drive-picker-state">
							{current ? "This folder has no folders." : `${drive.name} has no folders.`}
						</p>
					)}
					{drive !== null && state.status === "ready" && state.folders.length > 0 && (
						<ul className="drive-picker-list">
							{state.folders.map((folder) => (
								<li key={folder.id}>
									<button
										type="button"
										className="drive-picker-item"
										disabled={moving.has(folder.id)}
										title={moving.has(folder.id) ? "A folder cannot move into itself" : undefined}
										onClick={() => setTrail([...trail, { id: folder.id, name: folder.name }])}
									>
										<Icon name="folder" />
										<span className="drive-picker-name">{folder.name}</span>
										<Icon name="chevronRight" size={16} />
									</button>
								</li>
							))}
						</ul>
					)}
					{drive !== null && state.status === "ready" && state.nextCursor !== null && (
						<p className="drive-picker-state">
							<button
								type="button"
								className="button button-small"
								onClick={() => void load(drive.spaceId, currentId, state.nextCursor)}
							>
								More folders
							</button>
						</p>
					)}
				</div>
				{across && drive !== null && (
					<p className="field-hint drive-picker-hint">
						{drive.shared
							? `${drive.name} is a shared drive. After the move, it owns the items.`
							: "After the move, you own the items."}
					</p>
				)}
				{acrossRefusal && (
					<p className="form-error" role="alert">
						{acrossRefusal}
					</p>
				)}
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
			</div>
			<div className="dialog-actions">
				<button type="button" className="button" onClick={onClose} disabled={busy} data-autofocus>
					Cancel
				</button>
				<button
					type="button"
					className="button button-primary"
					onClick={() => void move()}
					disabled={busy || drive === null || alreadyThere || acrossRefusal !== null}
					title={drive === null ? "Select a drive" : alreadyThere ? "The items are in this folder" : undefined}
				>
					{busy ? "Moving…" : drive === null ? "Move" : across ? `Move to ${destination}…` : `Move to ${destination}`}
				</button>
			</div>
		</Dialog>
	);
}

type AcrossState =
	| { status: "checking" }
	| { status: "ready"; summary: MoveSummary }
	// The selection is too large for one call. A second try gives the same answer.
	| { status: "refused"; error: string }
	| { status: "error"; error: string };

/**
 * The confirmation of a move to a different drive (`drive.move_to_drive`). The dialog first makes a
 * dry run: the server checks the move and gives the totals, and nothing changes. The dialog then
 * says who owns the items after the move and who keeps a direct share. "Move" makes the move.
 *
 * The move is one call with each selected id, so the server moves each item or no item. In one call,
 * the server also counts an item only once when the selection has the item and a folder above it.
 * A selection of more than 100 items does not start (`moveAcrossRefusal`).
 */
export function MoveAcrossDialog({
	items,
	source,
	destination,
	onClose,
	onMoved,
}: {
	items: readonly DriveItem[];
	/** The drive that holds the items now. */
	source: MoveTarget;
	destination: MoveDestination;
	onClose: () => void;
	/** After the move. `moving` is true when the server completes the move after the call. */
	onMoved: (moving: boolean) => void;
}) {
	const ownSpaceId = useSession().whoami.principal.id;
	const [state, setState] = useState<AcrossState>({ status: "checking" });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { drive, folder } = destination;
	const place = folder ? `${folder.name} in ${drive.name}` : drive.name;

	const refusal = moveAcrossRefusal(items.length);

	const run = useCallback(
		(dryRun: boolean) =>
			api.call(
				"drive.move_to_drive",
				moveToDriveInput(
					source.spaceId,
					ownSpaceId,
					items.map((item) => item.id),
					{ spaceId: drive.spaceId, parentId: folder?.id ?? null },
					dryRun,
				),
			),
		[items, source.spaceId, ownSpaceId, drive.spaceId, folder?.id],
	);

	const check = useCallback(async () => {
		if (refusal !== null) return setState({ status: "refused", error: refusal });
		setState({ status: "checking" });
		try {
			setState({ status: "ready", summary: moveSummary(await run(true)) });
		} catch (caught) {
			setState({ status: "error", error: errorMessage(caught) });
		}
	}, [run, refusal]);

	useEffect(() => {
		void check();
	}, [check]);

	async function move() {
		setBusy(true);
		setError(null);
		try {
			const result = await run(false);
			onMoved(result.status === "moving");
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog
			title={`Move ${describeItems(items)} to ${place}?`}
			onClose={() => !busy && onClose()}
			className="dialog-small"
		>
			<div className="dialog-body" aria-live="polite">
				{state.status === "checking" && (
					<p className="drive-picker-state">
						<span className="spinner spinner-small" aria-hidden="true" /> Checking the move…
					</p>
				)}
				{state.status === "error" && (
					<p className="form-error" role="alert">
						The items cannot move. {state.error}{" "}
						<button type="button" className="link-button" onClick={() => void check()}>
							Try again
						</button>
					</p>
				)}
				{state.status === "refused" && (
					<p className="form-error" role="alert">
						{state.error}
					</p>
				)}
				{state.status === "ready" && <p>{moveConfirmText(items.length, source, drive, state.summary).join(" ")}</p>}
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
			</div>
			<div className="dialog-actions">
				<button type="button" className="button" onClick={onClose} disabled={busy} data-autofocus>
					Cancel
				</button>
				<button
					type="button"
					className="button button-primary"
					onClick={() => void move()}
					disabled={busy || state.status !== "ready"}
				>
					{busy ? "Moving…" : "Move"}
				</button>
			</div>
		</Dialog>
	);
}
