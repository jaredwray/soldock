import "./drive.css";
import { DRIVE_LIMITS, type DriveItem } from "@soldock/contracts";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useSession } from "../auth/session.tsx";
import { backPath, itemIcon, spaceInput } from "./model.ts";
import { ShareDialog } from "./ShareDialog.tsx";

/** The state of the last save of an editor. */
export type SaveState = "saved" | "saving" | "unsaved" | "error" | "conflict";

export interface DocumentHeaderProps {
	/** The doc or the sheet, as `docs.get` or `sheets.get` returned it. */
	item: DriveItem;
	/** The state of the last save. Null for a viewer, who cannot change the content. */
	saveState: SaveState | null;
	/** After a rename or a star change. The editor keeps the new item. */
	onItemChange: (item: DriveItem) => void;
	/** More controls of the editor, before the Share button. */
	actions?: ReactNode;
}

const SAVE_TEXT: Record<SaveState, string> = {
	saved: "Saved",
	saving: "Saving…",
	unsaved: "Not saved yet",
	error: "Not saved: the server did not accept the change",
	conflict: "Not saved: somebody else changed this document",
};

/**
 * The header of the Docs and the Sheets editor: the link back to Drive, the name (an editor can
 * change it), the star, the save state and the Share button.
 */
export function DocumentHeader({ item, saveState, onItemChange, actions }: DocumentHeaderProps) {
	const ownId = useSession().whoami.principal.id;
	const toast = useToast();
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(item.name);
	const [renaming, setRenaming] = useState(false);
	const [sharing, setSharing] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const nameButtonRef = useRef<HTMLButtonElement>(null);
	// A disabled input loses the focus, and the blur must not send the rename a second time.
	const renamingRef = useRef(false);
	// True after a rename ends from the keyboard: the focus then goes back to the name.
	const refocusRef = useRef(false);
	const canEdit = item.role === "owner" || item.role === "editor";
	const space = spaceInput(item.space_id, ownId);
	const failed = saveState === "error" || saveState === "conflict";

	useEffect(() => {
		if (editing) {
			inputRef.current?.focus();
			inputRef.current?.select();
		} else if (refocusRef.current) {
			refocusRef.current = false;
			nameButtonRef.current?.focus();
		}
	}, [editing]);

	function startRename() {
		setName(item.name);
		setEditing(true);
	}

	async function rename() {
		const trimmed = name.trim();
		if (renamingRef.current) return;
		if (!trimmed || trimmed === item.name) {
			setEditing(false);
			return;
		}
		renamingRef.current = true;
		setRenaming(true);
		try {
			const result = await api.call("drive.rename_item", { ...space, item_id: item.id, name: trimmed });
			onItemChange(result.item);
			setEditing(false);
		} catch (caught) {
			toast({ message: `The name did not change. ${errorMessage(caught)}`, tone: "error" });
			inputRef.current?.focus();
		} finally {
			renamingRef.current = false;
			setRenaming(false);
		}
	}

	async function toggleStar() {
		const starred = !item.starred;
		onItemChange({ ...item, starred });
		try {
			await api.call("drive.star_items", { ...space, item_ids: [item.id], starred });
		} catch (caught) {
			onItemChange({ ...item, starred: !starred });
			toast({ message: errorMessage(caught), tone: "error" });
		}
	}

	return (
		<header className="document-header">
			<Link
				to={backPath(item)}
				className="icon-button"
				aria-label={
					item.role === "owner" ? "Back to the folder in Drive" : "Back to the items that are shared with you"
				}
				title="Back to Drive"
			>
				<Icon name="back" />
			</Link>
			<Icon name={itemIcon(item)} size={24} className={`drive-kind drive-kind-${item.kind}`} />
			<div className="document-header-title">
				{editing ? (
					<form
						className="document-header-form"
						onSubmit={(event: FormEvent<HTMLFormElement>) => {
							event.preventDefault();
							refocusRef.current = true;
							void rename();
						}}
					>
						<label className="visually-hidden" htmlFor="document-name">
							Name
						</label>
						<input
							id="document-name"
							ref={inputRef}
							className="input document-header-input"
							value={name}
							maxLength={DRIVE_LIMITS.nameChars}
							autoComplete="off"
							disabled={renaming}
							onChange={(event) => setName(event.target.value)}
							onBlur={() => void rename()}
							onKeyDown={(event) => {
								if (event.key !== "Escape") return;
								event.preventDefault();
								refocusRef.current = true;
								setEditing(false);
							}}
						/>
					</form>
				) : (
					<h1 className="document-header-name">
						{canEdit ? (
							<button
								ref={nameButtonRef}
								type="button"
								className="document-header-rename"
								title="Rename"
								onClick={startRename}
							>
								{item.name}
								<span className="visually-hidden">, rename</span>
							</button>
						) : (
							item.name
						)}
					</h1>
				)}
				<p
					className={failed ? "document-header-state document-header-state-error" : "document-header-state"}
					role="status"
				>
					{saveState === null ? "View only" : SAVE_TEXT[saveState]}
				</p>
			</div>
			<button
				type="button"
				className={item.starred ? "icon-button icon-button-star" : "icon-button"}
				aria-label={item.starred ? "Remove star" : "Star"}
				aria-pressed={item.starred}
				title={item.starred ? "Remove star" : "Star"}
				onClick={() => void toggleStar()}
			>
				<Icon name="star" filled={item.starred} />
			</button>
			<span className="document-header-spacer" />
			{actions}
			{item.role === "owner" && (
				<button type="button" className="button button-primary" aria-label="Share" onClick={() => setSharing(true)}>
					<Icon name="share" size={18} />
					<span className="document-header-share">Share</span>
				</button>
			)}
			{sharing && <ShareDialog item={item} onClose={() => setSharing(false)} />}
		</header>
	);
}
