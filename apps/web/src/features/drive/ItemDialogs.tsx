import { DRIVE_LIMITS, type DriveItem } from "@soldock/contracts";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { plural } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useSession } from "../auth/session.tsx";
import { type CreateTarget, idBatches, kindName, spaceInput } from "./model.ts";

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

/**
 * Moves items of the own drive to a folder that the person selects. The dialog shows the folders of
 * one level. A click on a folder opens it. The server refuses a move of a folder into itself or
 * into a folder under it, and the dialog shows that error.
 */
export function MoveDialog({
	items,
	onClose,
	onMoved,
}: {
	items: readonly DriveItem[];
	onClose: () => void;
	onMoved: (destination: string) => void;
}) {
	// The folders from the root to the folder on screen. Empty for the root.
	const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
	const [state, setState] = useState<PickerState>(PICKER_LOADING);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const current = trail[trail.length - 1] ?? null;
	const currentId = current?.id ?? null;
	const moving = new Set(items.map((item) => item.id));
	const first = items[0];
	const alreadyThere = items.every((item) => (item.parent_id ?? null) === currentId);

	// Only the answer of the last request shows, so a slow answer for one folder cannot fill a different one.
	const requestRef = useRef(0);

	const load = useCallback(async (parentId: string | null, cursor: string | null) => {
		const request = ++requestRef.current;
		if (cursor === null) setState(PICKER_LOADING);
		try {
			const result = await api.call("drive.list_items", {
				view: "folder",
				kind: "folder",
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
	}, []);

	useEffect(() => {
		void load(currentId, null);
	}, [load, currentId]);

	async function move() {
		setBusy(true);
		setError(null);
		try {
			for (const batch of idBatches(items.map((item) => item.id))) {
				await api.call("drive.move_items", { item_ids: batch, ...(currentId ? { parent_id: currentId } : {}) });
			}
			onMoved(current?.name ?? "My Drive");
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog
			title={items.length === 1 && first ? `Move “${first.name}”` : `Move ${plural(items.length, "item")}`}
			onClose={() => !busy && onClose()}
		>
			<div className="dialog-body">
				<nav aria-label="Folder path" className="drive-picker-path">
					<button type="button" className="link-button" disabled={trail.length === 0} onClick={() => setTrail([])}>
						My Drive
					</button>
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
					{state.status === "loading" && (
						<p className="drive-picker-state">
							<span className="spinner spinner-small" aria-hidden="true" /> Loading folders…
						</p>
					)}
					{state.status === "error" && (
						<p className="drive-picker-state" role="alert">
							The folders did not load. {state.error}{" "}
							<button type="button" className="link-button" onClick={() => void load(currentId, null)}>
								Try again
							</button>
						</p>
					)}
					{state.status === "ready" && state.folders.length === 0 && (
						<p className="drive-picker-state">This folder has no folders.</p>
					)}
					{state.status === "ready" && state.folders.length > 0 && (
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
					{state.status === "ready" && state.nextCursor !== null && (
						<p className="drive-picker-state">
							<button
								type="button"
								className="button button-small"
								onClick={() => void load(currentId, state.nextCursor)}
							>
								More folders
							</button>
						</p>
					)}
				</div>
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
					onClick={move}
					disabled={busy || alreadyThere}
					title={alreadyThere ? "The items are in this folder" : undefined}
				>
					{busy ? "Moving…" : `Move to ${current?.name ?? "My Drive"}`}
				</button>
			</div>
		</Dialog>
	);
}
