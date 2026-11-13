import "./drive.css";
import type { DriveItem } from "@soldock/contracts";
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fileToBase64 } from "../../lib/base64.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { plural } from "../../lib/format.ts";
import { Icon, type IconName } from "../../lib/icons.tsx";
import { Link, navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { type DriveView, drivePath, itemPath } from "../../routes.ts";
import { useSession } from "../auth/session.tsx";
import { DriveSidebar, type NavEntry } from "./DriveSidebar.tsx";
import { downloadFile, useAboutPoll, useFolder, useItemList, usePrincipals } from "./data.ts";
import { MoveDialog, NewFolderDialog, RenameDialog } from "./ItemDialogs.tsx";
import { ItemList } from "./ItemList.tsx";
import type { MenuItem } from "./Menu.tsx";
import {
	type BulkAction,
	breadcrumbs,
	bulkActions,
	createTarget,
	type ItemAction,
	type ItemOrder,
	idBatches,
	isForeignFolder,
	itemActions,
	listInput,
	spaceInput,
	uploadMimeType,
	uploadRefusal,
	viewTitle,
} from "./model.ts";
import { PreviewDialog } from "./PreviewDialog.tsx";
import { ShareDialog } from "./ShareDialog.tsx";
import { VersionsDialog } from "./VersionsDialog.tsx";

export interface DriveAppProps {
	view: DriveView;
	/** True while the navigation drawer is open, under 768px. */
	navOpen: boolean;
	onCloseNav: () => void;
}

type DriveDialog =
	| { type: "new-folder" }
	| { type: "rename"; item: DriveItem }
	| { type: "move"; items: DriveItem[] }
	| { type: "share"; item: DriveItem }
	| { type: "versions"; item: DriveItem }
	| { type: "preview"; item: DriveItem }
	| { type: "delete"; items: DriveItem[] }
	| { type: "leave"; item: DriveItem }
	| { type: "empty-trash" }
	| null;

const ACTION_MENU: Record<ItemAction, { label: string; icon: IconName; danger?: boolean }> = {
	open: { label: "Open", icon: "eye" },
	download: { label: "Download", icon: "download" },
	rename: { label: "Rename", icon: "pencil" },
	move: { label: "Move", icon: "folderMove" },
	copy: { label: "Make a copy", icon: "copy" },
	share: { label: "Share", icon: "share" },
	access: { label: "See who has access", icon: "team" },
	versions: { label: "Versions", icon: "history" },
	trash: { label: "Move to trash", icon: "trash" },
	leave: { label: "Remove from my list", icon: "close" },
	restore: { label: "Restore", icon: "restore" },
	delete: { label: "Delete forever", icon: "trash", danger: true },
};

function navEntry(view: DriveView, foreign: boolean): NavEntry {
	if (view.kind === "folder") return foreign ? "shared" : "my-drive";
	return view.kind === "search" ? null : view.kind;
}

/** `“Report.pdf”` for one item, and `3 items` for more. */
function describe(items: readonly DriveItem[]): string {
	const first = items[0];
	return items.length === 1 && first ? `“${first.name}”` : plural(items.length, "item");
}

/**
 * The Drive product: the navigation, the item list of the current view, and the dialogs. It owns the
 * data that each part shares: the poll of the own drive, the list, the folder of a folder view and
 * the selection. The list and the folder belong to one view, so a new view starts clean.
 */
export function DriveApp({ view, navOpen, onCloseNav }: DriveAppProps) {
	const { whoami } = useSession();
	const ownId = whoami.principal.id;
	const toast = useToast();
	const [order, setOrder] = useState<ItemOrder>("name");
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [dialog, setDialog] = useState<DriveDialog>(null);
	const [upload, setUpload] = useState<{ done: number; total: number } | null>(null);
	const [dragging, setDragging] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const creatingRef = useRef(false);
	const closeNavRef = useRef(onCloseNav);

	const viewKey = drivePath(view);
	const foreign = isForeignFolder(view, ownId);
	const input = useMemo(() => listInput(view, order, ownId), [view, order, ownId]);
	const list = useItemList(input);
	const folderState = useFolder(
		view.kind === "folder" ? spaceInput(view.spaceId, ownId) : {},
		view.kind === "folder" ? view.folderId : null,
	);
	const principals = usePrincipals();
	const names = useMemo(
		() => new Map((principals ?? []).map((principal) => [principal.id, principal.display_name])),
		[principals],
	);

	const { refresh: refreshList } = list;
	const { reload: reloadFolder } = folderState;
	const refresh = useCallback(() => {
		void refreshList();
		void reloadFolder();
	}, [refreshList, reloadFolder]);

	// The version of the own drive does not change for an item in the drive of somebody else. The views
	// that can show such items get their list again on the timer.
	const showsOtherDrives = foreign || view.kind === "shared" || view.kind === "starred";
	const { about, sync } = useAboutPoll(refresh, () => {
		if (showsOtherDrives) refresh();
	});

	/** After a change in this tab: get the list, the folder and the totals again. */
	const changed = useCallback(() => {
		refresh();
		void sync();
	}, [refresh, sync]);

	useEffect(() => {
		closeNavRef.current = onCloseNav;
	});

	useOnChange(viewKey, () => {
		setSelected(new Set());
		setDialog(null);
	});

	const folder = folderState.folder;
	const title = viewTitle(view, folder?.item.name ?? null);
	// A folder that did not load, for example after its owner removed the access, takes no new items.
	const target = folderState.status === "error" ? null : createTarget(view, folder?.item.role ?? null, ownId);
	const inTrash = view.kind === "trash";
	const selectedItems = list.items.filter((item) => selected.has(item.id));
	const bulk = bulkActions(selectedItems);

	useEffect(() => {
		document.title = `${title} – Soldock`;
	}, [title]);

	useEffect(() => {
		if (!navOpen) return;
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") closeNavRef.current();
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [navOpen]);

	const fail = (caught: unknown) => toast({ message: errorMessage(caught), tone: "error" });

	function clearSelection() {
		setSelected(new Set());
	}

	function toggleSelect(itemId: string) {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(itemId)) next.delete(itemId);
			else next.add(itemId);
			return next;
		});
	}

	function toggleAll() {
		setSelected(selectedItems.length === list.items.length ? new Set() : new Set(list.items.map((item) => item.id)));
	}

	/** Sets or removes the star of the person. The items can be in more than one drive: one call for each. */
	async function star(items: readonly DriveItem[], starred: boolean) {
		const ids = items.map((item) => item.id);
		list.patch(ids, (item) => (view.kind === "starred" && !starred ? null : { ...item, starred }));
		const bySpace = new Map<string, string[]>();
		for (const item of items) bySpace.set(item.space_id, [...(bySpace.get(item.space_id) ?? []), item.id]);
		try {
			for (const [spaceId, itemIds] of bySpace) {
				for (const batch of idBatches(itemIds)) {
					await api.call("drive.star_items", { ...spaceInput(spaceId, ownId), item_ids: batch, starred });
				}
			}
		} catch (caught) {
			fail(caught);
			refresh();
		}
	}

	async function restoreAll(ids: readonly string[]) {
		for (const batch of idBatches(ids)) await api.call("drive.restore_items", { item_ids: batch });
	}

	async function trash(items: readonly DriveItem[]) {
		const ids = items.map((item) => item.id);
		list.patch(ids, () => null);
		clearSelection();
		try {
			for (const batch of idBatches(ids)) await api.call("drive.trash_items", { item_ids: batch });
			toast({
				message: `Moved ${describe(items)} to the trash.`,
				action: {
					label: "Undo",
					run: () => {
						restoreAll(ids).then(changed, fail);
					},
				},
			});
			changed();
		} catch (caught) {
			fail(caught);
			refresh();
		}
	}

	async function restore(items: readonly DriveItem[]) {
		const ids = items.map((item) => item.id);
		list.patch(ids, () => null);
		clearSelection();
		try {
			await restoreAll(ids);
			toast({ message: `Restored ${describe(items)}.` });
			changed();
		} catch (caught) {
			fail(caught);
			refresh();
		}
	}

	async function copy(item: DriveItem) {
		try {
			const result = await api.call("drive.copy_item", {
				...spaceInput(item.space_id, ownId),
				item_id: item.id,
				// A copy of an own item goes next to it. A copy of an item of somebody else goes to the root of the own drive.
				...(item.space_id === ownId && item.parent_id ? { parent_id: item.parent_id } : {}),
				idempotency_key: crypto.randomUUID(),
			});
			toast({
				message:
					item.space_id === ownId ? `Created “${result.item.name}”.` : `Created “${result.item.name}” in your drive.`,
			});
			changed();
		} catch (caught) {
			fail(caught);
		}
	}

	function open(item: DriveItem) {
		const path = itemPath(item);
		if (path !== null) navigate(path);
		else setDialog({ type: "preview", item });
	}

	function act(action: ItemAction, item: DriveItem) {
		switch (action) {
			case "open":
				return open(item);
			case "download":
				return void downloadFile(item, ownId).catch(fail);
			case "rename":
				return setDialog({ type: "rename", item });
			case "move":
				return setDialog({ type: "move", items: [item] });
			case "copy":
				return void copy(item);
			case "share":
			case "access":
				return setDialog({ type: "share", item });
			case "versions":
				return setDialog({ type: "versions", item });
			case "trash":
				return void trash([item]);
			case "leave":
				return setDialog({ type: "leave", item });
			case "restore":
				return void restore([item]);
			case "delete":
				return setDialog({ type: "delete", items: [item] });
		}
	}

	function menuItems(item: DriveItem): MenuItem[] {
		return itemActions(item, { sharedView: view.kind === "shared" }).map((action) => ({
			key: action,
			...ACTION_MENU[action],
			...(action === "open" && item.kind === "file" ? { label: "Preview" } : {}),
			onSelect: () => act(action, item),
		}));
	}

	function actBulk(action: BulkAction) {
		switch (action) {
			case "move":
				return setDialog({ type: "move", items: selectedItems });
			case "trash":
				return void trash(selectedItems);
			case "restore":
				return void restore(selectedItems);
			case "delete":
				return setDialog({ type: "delete", items: selectedItems });
		}
	}

	/** Creates an empty doc or sheet in the current folder, then opens its editor. */
	async function createDocument(kind: "doc" | "sheet") {
		if (target === null || creatingRef.current) return;
		creatingRef.current = true;
		closeNavRef.current();
		try {
			const idempotencyKey = crypto.randomUUID();
			const result =
				kind === "doc"
					? await api.call("docs.create", { ...target, name: "Untitled document", idempotency_key: idempotencyKey })
					: await api.call("sheets.create", {
							...target,
							name: "Untitled spreadsheet",
							idempotency_key: idempotencyKey,
						});
			navigate(itemPath(result.item) ?? viewKey);
		} catch (caught) {
			fail(caught);
		} finally {
			creatingRef.current = false;
		}
	}

	/** Uploads files to the current folder, one at a time. A file over the limit is refused before it is read. */
	async function uploadFiles(files: readonly File[]) {
		if (target === null || files.length === 0 || upload !== null) return;
		let uploaded = 0;
		setUpload({ done: 0, total: files.length });
		for (const [index, file] of files.entries()) {
			const refusal = uploadRefusal(file);
			if (refusal) {
				toast({ message: refusal, tone: "error" });
			} else {
				try {
					const mimeType = uploadMimeType(file.type);
					await api.call("drive.upload_file", {
						...target,
						name: file.name,
						...(mimeType ? { mime_type: mimeType } : {}),
						content_base64: await fileToBase64(file),
						idempotency_key: crypto.randomUUID(),
					});
					uploaded += 1;
				} catch (caught) {
					toast({ message: `“${file.name}” did not upload. ${errorMessage(caught)}`, tone: "error" });
				}
			}
			setUpload({ done: index + 1, total: files.length });
		}
		setUpload(null);
		if (uploaded > 0) {
			toast({ message: `Uploaded ${plural(uploaded, "file")}.` });
			changed();
		}
	}

	const newItems: MenuItem[] =
		target === null
			? []
			: [
					{
						key: "folder",
						label: "New folder",
						icon: "folderPlus",
						onSelect: () => {
							closeNavRef.current();
							setDialog({ type: "new-folder" });
						},
					},
					{
						key: "upload",
						label: "File upload",
						icon: "upload",
						onSelect: () => {
							closeNavRef.current();
							fileInputRef.current?.click();
						},
					},
					{ key: "doc", label: "New doc", icon: "doc", onSelect: () => void createDocument("doc") },
					{ key: "sheet", label: "New sheet", icon: "sheet", onSelect: () => void createDocument("sheet") },
				];

	// A drop of files uploads them to the folder on screen, when the person can add items there.
	const canDrop = target !== null && view.kind === "folder";

	function onDragOver(event: DragEvent<HTMLElement>) {
		if (!canDrop || !event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		setDragging(true);
	}

	function onDragLeave(event: DragEvent<HTMLElement>) {
		if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
		setDragging(false);
	}

	function onDrop(event: DragEvent<HTMLElement>) {
		if (!canDrop || !event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		setDragging(false);
		void uploadFiles([...event.dataTransfer.files]);
	}

	const selection = selectedItems.length === 0 ? "none" : selectedItems.length === list.items.length ? "all" : "some";
	const allStarred = selectedItems.length > 0 && selectedItems.every((item) => item.starred);

	return (
		<div className="drive-layout">
			<DriveSidebar
				active={navEntry(view, foreign)}
				about={about}
				open={navOpen}
				newItems={newItems}
				onClose={onCloseNav}
			/>
			<main
				id="main"
				className={dragging ? "drive-main drive-main-drop" : "drive-main"}
				tabIndex={-1}
				onDragOver={onDragOver}
				onDragLeave={onDragLeave}
				onDrop={onDrop}
			>
				<div className="drive-header">
					{view.kind === "folder" ? (
						<nav aria-label="Folder path" className="drive-crumbs">
							<ol>
								{breadcrumbs(view, folder, ownId).map((crumb, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: two folders of a path can have the same name.
									<li key={index}>
										{index > 0 && <Icon name="chevronRight" size={16} />}
										{crumb.to !== null ? (
											<Link to={crumb.to} className="drive-crumb">
												{crumb.label}
											</Link>
										) : (
											<h1 className="drive-crumb drive-crumb-current" aria-current="page">
												{crumb.label}
											</h1>
										)}
									</li>
								))}
								{view.folderId !== null && folderState.status === "loading" && (
									<li>
										<Icon name="chevronRight" size={16} />
										<h1 className="drive-crumb drive-crumb-current muted">…</h1>
									</li>
								)}
							</ol>
						</nav>
					) : (
						<h1 className="drive-title">{title}</h1>
					)}
					{foreign && folder && (
						<span className="chip chip-small">{folder.item.role === "viewer" ? "View only" : "You can edit"}</span>
					)}
				</div>
				<div className="toolbar">
					<SelectAll
						selection={selection}
						disabled={list.status !== "ready" || list.items.length === 0}
						onToggle={toggleAll}
					/>
					{selectedItems.length === 0 ? (
						<>
							<button type="button" className="icon-button" aria-label="Refresh" title="Refresh" onClick={changed}>
								<Icon name="refresh" />
							</button>
							{inTrash && list.status === "ready" && list.items.length > 0 && (
								<button
									type="button"
									className="button button-small button-danger-outline"
									onClick={() => setDialog({ type: "empty-trash" })}
								>
									<Icon name="trash" size={16} />
									Empty trash
								</button>
							)}
						</>
					) : (
						<div className="toolbar-actions">
							{!inTrash && (
								<button
									type="button"
									className={allStarred ? "icon-button icon-button-star" : "icon-button"}
									aria-label={allStarred ? "Remove star" : "Star"}
									title={allStarred ? "Remove star" : "Star"}
									onClick={() => void star(selectedItems, !allStarred)}
								>
									<Icon name="star" filled={allStarred} />
								</button>
							)}
							{bulk.includes("move") && <ToolButton icon="folderMove" label="Move" onClick={() => actBulk("move")} />}
							{bulk.includes("trash") && (
								<ToolButton icon="trash" label="Move to trash" onClick={() => actBulk("trash")} />
							)}
							{bulk.includes("restore") && (
								<TextButton icon="restore" label="Restore" onClick={() => actBulk("restore")} />
							)}
							{bulk.includes("delete") && (
								<TextButton icon="trash" label="Delete forever" danger onClick={() => actBulk("delete")} />
							)}
						</div>
					)}
					<span className="toolbar-spacer" />
					{selectedItems.length > 0 && (
						<span className="toolbar-title" role="status">
							{selectedItems.length} selected
						</span>
					)}
				</div>
				{inTrash && <p className="drive-note">An item stays in the trash until you delete it forever.</p>}
				<div className="drive-scroll">
					<ItemList
						view={view}
						title={title}
						list={list}
						ownSpaceId={ownId}
						names={names}
						selected={selected}
						order={order}
						onOrder={setOrder}
						onToggleSelect={toggleSelect}
						onToggleStar={(item) => void star([item], !item.starred)}
						onOpenFile={open}
						menuItems={menuItems}
						onLoadMore={() => void list.loadMore().catch(fail)}
						onRetry={() => void list.retry()}
					/>
				</div>
				{dragging && (
					<div className="drive-drop" aria-hidden="true">
						<Icon name="upload" size={32} />
						Drop the files to upload them to {title}
					</div>
				)}
				<p className={upload ? "drive-upload" : "visually-hidden"} role="status">
					{upload && (
						<>
							<span className="spinner spinner-small" aria-hidden="true" />
							{`Uploading file ${Math.min(upload.done + 1, upload.total)} of ${upload.total}…`}
						</>
					)}
				</p>
				<input
					ref={fileInputRef}
					type="file"
					multiple
					hidden
					onChange={(event) => {
						const files = [...(event.target.files ?? [])];
						event.target.value = "";
						void uploadFiles(files);
					}}
				/>
			</main>
			{dialog?.type === "new-folder" && target !== null && (
				<NewFolderDialog
					target={target}
					onClose={() => setDialog(null)}
					onCreated={(item) => {
						setDialog(null);
						toast({ message: `Folder “${item.name}” created.` });
						changed();
					}}
				/>
			)}
			{dialog?.type === "rename" && (
				<RenameDialog
					item={dialog.item}
					onClose={() => setDialog(null)}
					onRenamed={() => {
						setDialog(null);
						changed();
					}}
				/>
			)}
			{dialog?.type === "move" && (
				<MoveDialog
					items={dialog.items}
					onClose={() => setDialog(null)}
					onMoved={(destination) => {
						toast({ message: `Moved ${describe(dialog.items)} to ${destination}.` });
						setDialog(null);
						clearSelection();
						changed();
					}}
				/>
			)}
			{dialog?.type === "share" && (
				<ShareDialog item={dialog.item} onClose={() => setDialog(null)} onChanged={changed} />
			)}
			{dialog?.type === "versions" && (
				<VersionsDialog item={dialog.item} onClose={() => setDialog(null)} onChanged={changed} />
			)}
			{dialog?.type === "preview" && <PreviewDialog item={dialog.item} onClose={() => setDialog(null)} />}
			{dialog?.type === "delete" && (
				<ConfirmDialog
					title="Delete forever?"
					confirmLabel="Delete forever"
					danger
					onClose={() => setDialog(null)}
					onConfirm={async () => {
						for (const batch of idBatches(dialog.items.map((item) => item.id))) {
							await api.call("drive.delete_items", { item_ids: batch });
						}
						toast({ message: `Deleted ${describe(dialog.items)}.` });
						clearSelection();
						changed();
					}}
				>
					<p>
						Delete {describe(dialog.items)} forever? A folder goes with all that it holds, and a file goes with each of
						its versions. You cannot get them back.
					</p>
				</ConfirmDialog>
			)}
			{dialog?.type === "empty-trash" && (
				<ConfirmDialog
					title="Empty the trash?"
					confirmLabel="Empty trash"
					danger
					onClose={() => setDialog(null)}
					onConfirm={async () => {
						await api.call("drive.empty_trash", {});
						toast({ message: "The trash is empty." });
						clearSelection();
						changed();
					}}
				>
					<p>Delete each item in the trash forever? You cannot get them back.</p>
				</ConfirmDialog>
			)}
			{dialog?.type === "leave" && (
				<ConfirmDialog
					title="Remove from your list?"
					confirmLabel="Remove"
					danger
					onClose={() => setDialog(null)}
					onConfirm={async () => {
						const result = await api.call("drive.unshare_item", {
							space_id: dialog.item.space_id,
							item_id: dialog.item.id,
							principal_id: ownId,
						});
						if (!result.removed) {
							throw new Error("Your access comes from a folder above this item. Only the owner can remove it.");
						}
						toast({ message: `Removed “${dialog.item.name}” from your list.` });
						changed();
					}}
				>
					<p>
						Remove <strong>{dialog.item.name}</strong> from the items that are shared with you? You then have no access
						to it. The owner can share it with you again.
					</p>
				</ConfirmDialog>
			)}
		</div>
	);
}

function SelectAll({
	selection,
	disabled,
	onToggle,
}: {
	selection: "none" | "some" | "all";
	disabled: boolean;
	onToggle: () => void;
}) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (ref.current) ref.current.indeterminate = selection === "some";
	}, [selection]);
	return (
		<label className="select-all" title="Select all">
			<input
				ref={ref}
				type="checkbox"
				className="checkbox"
				checked={selection === "all"}
				disabled={disabled}
				onChange={onToggle}
			/>
			<span className="visually-hidden">Select all items</span>
		</label>
	);
}

function ToolButton({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
	return (
		<button type="button" className="icon-button" aria-label={label} title={label} onClick={onClick}>
			<Icon name={icon} />
		</button>
	);
}

function TextButton({
	icon,
	label,
	danger,
	onClick,
}: {
	icon: IconName;
	label: string;
	danger?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			className={danger ? "button button-small button-danger-outline" : "button button-small"}
			onClick={onClick}
		>
			<Icon name={icon} size={16} />
			{label}
		</button>
	);
}
