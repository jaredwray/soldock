import "./drive.css";
import type { DriveItem } from "@soldock/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fileToBase64 } from "../../lib/base64.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { formatBytes, plural } from "../../lib/format.ts";
import { Icon, type IconName } from "../../lib/icons.tsx";
import { Link, navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { type DriveView, drivePath, itemPath } from "../../routes.ts";
import { SearchBox } from "../../shell/SearchBox.tsx";
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
	type CreateTarget,
	createTarget,
	type DropZone,
	dropZone,
	folderRefusal,
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
	/** True while the navigation drawer is open, at 900px and below. */
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

/** The icon before the title of a view. The root of the own drive has the icon of its sidebar entry. */
function viewIcon(view: DriveView, foreign: boolean): IconName {
	switch (view.kind) {
		case "folder":
			return view.folderId === null && !foreign ? "drive" : "folder";
		case "shared":
			return "team";
		case "recent":
			return "clock";
		case "starred":
			return "star";
		case "trash":
			return "trash";
		case "search":
			return "search";
	}
}

function navEntry(view: DriveView, foreign: boolean): NavEntry {
	if (view.kind === "folder") return foreign ? "shared" : "my-drive";
	return view.kind === "search" ? null : view.kind;
}

/** One file of the upload queue, and the folder that gets it. */
interface UploadJob {
	file: File;
	target: CreateTarget;
	/** The name of the folder, for the toast. */
	destination: string;
}

/** The files of a drop, and the names of its folders. Drive uploads only files. */
function droppedFiles(data: DataTransfer): { files: File[]; folders: string[] } {
	const files: File[] = [];
	const folders: string[] = [];
	for (const item of Array.from(data.items)) {
		if (item.kind !== "file") continue;
		const entry = item.webkitGetAsEntry();
		const file = item.getAsFile();
		if (entry?.isDirectory) folders.push(entry.name);
		else if (file) files.push(file);
	}
	// A browser without `items` gives only the list of files.
	if (files.length === 0 && folders.length === 0) files.push(...Array.from(data.files));
	return { files, folders };
}

function sameZone(a: DropZone | null, b: DropZone | null): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
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
	const [upload, setUpload] = useState<{ done: number; total: number; name: string; size: number } | null>(null);
	const [drop, setDrop] = useState<DropZone | null>(null);
	const mainRef = useRef<HTMLElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const creatingRef = useRef(false);
	const closeNavRef = useRef(onCloseNav);
	const queueRef = useRef<UploadJob[]>([]);
	const uploadingRef = useRef(false);

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

	const changedRef = useRef(changed);
	useEffect(() => {
		closeNavRef.current = onCloseNav;
		changedRef.current = changed;
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

	/**
	 * Adds files to the upload queue. The queue uploads one file at a time, so the files of a drop
	 * during an upload wait for their turn.
	 */
	function enqueueUploads(files: readonly File[], uploadTarget: CreateTarget, destination: string) {
		if (files.length === 0) return;
		queueRef.current.push(...files.map((file) => ({ file, target: uploadTarget, destination })));
		if (uploadingRef.current) setUpload((current) => current && { ...current, total: current.total + files.length });
		else void runUploads();
	}

	/** Uploads the queue, each file with an idempotency key. A file over the limit is refused before it is read. */
	async function runUploads() {
		uploadingRef.current = true;
		const queue = queueRef.current;
		// The name of each folder that got a file, by its target: two folders can have the same name.
		const destinations = new Map<string, string>();
		let done = 0;
		let uploaded = 0;
		for (let job = queue.shift(); job; job = queue.shift()) {
			const { file } = job;
			setUpload({ done, total: done + 1 + queue.length, name: file.name, size: file.size });
			const refusal = uploadRefusal(file);
			if (refusal) {
				toast({ message: refusal, tone: "error" });
			} else {
				try {
					const mimeType = uploadMimeType(file.type);
					await api.call("drive.upload_file", {
						...job.target,
						name: file.name,
						...(mimeType ? { mime_type: mimeType } : {}),
						content_base64: await fileToBase64(file),
						idempotency_key: crypto.randomUUID(),
					});
					uploaded += 1;
					destinations.set(JSON.stringify(job.target), job.destination);
				} catch (caught) {
					toast({ message: `“${file.name}” did not upload. ${errorMessage(caught)}`, tone: "error" });
				}
			}
			done += 1;
		}
		uploadingRef.current = false;
		setUpload(null);
		if (uploaded > 0) {
			const [only] = destinations.values();
			const files = plural(uploaded, "file");
			toast({ message: destinations.size === 1 ? `Uploaded ${files} to ${only}.` : `Uploaded ${files}.` });
			changedRef.current();
		}
	}

	/** The folder that gets the files of New › File upload. */
	const newDestination = view.kind === "folder" ? title : "My Drive";

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

	// The listeners of the window need the zone and the queue of the current render.
	const zoneAtRef = useRef<(node: EventTarget | null) => DropZone | null>(() => null);
	const acceptDropRef = useRef<(data: DataTransfer, zone: DropZone) => void>(() => {});
	useEffect(() => {
		zoneAtRef.current = (node) => {
			const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
			if (!element || !mainRef.current?.contains(element)) return null;
			const rowId = element.closest<HTMLElement>("[data-item-id]")?.dataset.itemId;
			const row = list.items.find((item) => item.id === rowId) ?? null;
			return dropZone(view, target, title, row, ownId);
		};
		acceptDropRef.current = (data, zone) => {
			const { files, folders } = droppedFiles(data);
			if (folders.length > 0) toast({ message: folderRefusal(folders), tone: "error" });
			enqueueUploads(files, zone.target, zone.name);
		};
	});

	// Files that the person drags from the computer upload to the zone under the pointer. The listeners
	// are on the window: a drop outside a zone then does nothing. Without them, the browser opens the
	// file in place of the app.
	useEffect(() => {
		// The count of the elements that the drag is in. Safari gives no related target on dragleave.
		let depth = 0;
		// A browser sends dragover at least each 550 ms during a drag. After a longer time with no
		// dragover, the drag is gone. This also clears a count that is too high: a node that the page
		// removes during the drag gives no dragleave.
		let idle = 0;
		const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
		function reset() {
			window.clearTimeout(idle);
			depth = 0;
			setDrop(null);
		}
		function onDragOver(event: DragEvent) {
			if (!event.dataTransfer || !hasFiles(event)) return;
			event.preventDefault();
			window.clearTimeout(idle);
			idle = window.setTimeout(reset, 1000);
			const zone = zoneAtRef.current(event.target);
			event.dataTransfer.dropEffect = zone ? "copy" : "none";
			setDrop((current) => (sameZone(current, zone) ? current : zone));
		}
		function onDragEnter(event: DragEvent) {
			if (!hasFiles(event)) return;
			depth += 1;
			onDragOver(event);
		}
		function onDragLeave(event: DragEvent) {
			if (!hasFiles(event)) return;
			depth = Math.max(0, depth - 1);
			if (depth === 0) reset();
		}
		function onDrop(event: DragEvent) {
			if (!event.dataTransfer || !hasFiles(event)) return;
			event.preventDefault();
			reset();
			const zone = zoneAtRef.current(event.target);
			if (zone) acceptDropRef.current(event.dataTransfer, zone);
		}
		window.addEventListener("dragenter", onDragEnter);
		window.addEventListener("dragover", onDragOver);
		window.addEventListener("dragleave", onDragLeave);
		window.addEventListener("drop", onDrop);
		return () => {
			window.clearTimeout(idle);
			window.removeEventListener("dragenter", onDragEnter);
			window.removeEventListener("dragover", onDragOver);
			window.removeEventListener("dragleave", onDragLeave);
			window.removeEventListener("drop", onDrop);
		};
	}, []);

	const selection = selectedItems.length === 0 ? "none" : selectedItems.length === list.items.length ? "all" : "some";
	const allStarred = selectedItems.length > 0 && selectedItems.every((item) => item.starred);
	const crumbs = view.kind === "folder" ? breadcrumbs(view, folder, ownId) : [];
	// The folder above the folder on screen. While the folder loads, this is the root of the drive.
	const upCrumb = crumbs.findLast((crumb) => crumb.to !== null);

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
				ref={mainRef}
				className={drop && drop.rowId === null ? "drive-main drive-main-drop" : "drive-main"}
				tabIndex={-1}
			>
				<div className="drive-header">
					<Icon name={viewIcon(view, foreign)} size={22} className="drive-header-icon" />
					{/* A phone shows only the folder on screen. This link goes to the folder above. */}
					{upCrumb?.to && (
						<Link
							to={upCrumb.to}
							className="icon-button drive-up"
							aria-label={`Up to ${upCrumb.label}`}
							title={`Up to ${upCrumb.label}`}
						>
							<Icon name="back" />
						</Link>
					)}
					{view.kind === "folder" ? (
						<nav aria-label="Folder path" className="drive-crumbs">
							<ol>
								{crumbs.map((crumb, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: two folders of a path can have the same name.
									<li key={index}>
										{index > 0 && <Icon name="chevronRight" size={14} />}
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
										<Icon name="chevronRight" size={14} />
										<h1 className="drive-crumb drive-crumb-current muted">…</h1>
									</li>
								)}
							</ol>
						</nav>
					) : (
						<h1 className="drive-title">{title}</h1>
					)}
					{foreign && folder && (
						<span className="chip drive-chip">{folder.item.role === "viewer" ? "View only" : "You can edit"}</span>
					)}
					<span className="toolbar-spacer" />
					<SearchBox product="drive" query={view.kind === "search" ? view.query : ""} />
				</div>
				<div className="toolbar">
					<SelectAll
						selection={selection}
						disabled={list.status !== "ready" || list.items.length === 0}
						onToggle={toggleAll}
					/>
					<span className={selectedItems.length > 0 ? "drive-selected-count" : "visually-hidden"} role="status">
						{selectedItems.length > 0 ? `${selectedItems.length} selected` : ""}
					</span>
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
						dropRowId={drop?.rowId ?? null}
						onOrder={setOrder}
						onToggleSelect={toggleSelect}
						onToggleStar={(item) => void star([item], !item.starred)}
						onOpenFile={open}
						menuItems={menuItems}
						onLoadMore={() => void list.loadMore().catch(fail)}
						onRetry={() => void list.retry()}
					/>
				</div>
				{drop && (
					<div className="drive-drop" aria-hidden="true">
						<Icon name="upload" size={18} />
						<span className="drive-drop-text">
							Drop the files to upload them to <strong>{drop.name}</strong>
						</span>
					</div>
				)}
				<div className={upload ? "drive-upload" : "visually-hidden"} role="status">
					{upload && (
						<>
							<span className="drive-upload-head">
								<strong className="drive-upload-name">{upload.name}</strong>
								<span className="drive-upload-size">{formatBytes(upload.size)}</span>
							</span>
							<progress className="drive-upload-bar" max={upload.total} value={upload.done} aria-hidden="true" />
							<span className="drive-upload-text">
								{`Uploading file ${Math.min(upload.done + 1, upload.total)} of ${upload.total}…`}
							</span>
						</>
					)}
				</div>
				<input
					ref={fileInputRef}
					type="file"
					multiple
					hidden
					onChange={(event) => {
						const files = [...(event.target.files ?? [])];
						event.target.value = "";
						if (target !== null) enqueueUploads(files, target, newDestination);
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
