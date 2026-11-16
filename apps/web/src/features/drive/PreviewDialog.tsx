import type { DriveItem } from "@soldock/contracts";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { base64ToBytes, saveBytes } from "../../lib/base64.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { formatBytes, fullDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { useSession } from "../auth/session.tsx";
import { itemIcon, type PreviewKind, type PreviewNeighbors, previewKind, spaceInput } from "./model.ts";

/** The characters of a text file that the preview shows. */
const TEXT_PREVIEW_CHARS = 200_000;

type Content =
	| { status: "none" }
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "image"; url: string; bytes: Uint8Array<ArrayBuffer> }
	| { status: "text"; text: string; cut: boolean; bytes: Uint8Array<ArrayBuffer> };

function initialContent(kind: PreviewKind): Content {
	return kind === "none" ? { status: "none" } : { status: "loading" };
}

interface PreviewDialogProps {
	item: DriveItem;
	/** The files before and after this file in the list on the page. */
	neighbors: PreviewNeighbors<DriveItem>;
	/** Shows a different file of the list in the same dialog. */
	onShow: (item: DriveItem) => void;
	onClose: () => void;
}

/**
 * Shows a file over the page, as a lightbox. A raster image shows from a `blob:` URL, and text shows as plain text. The content
 * of a file never goes into the page as HTML. Each other type shows its details and a download.
 * Previous and Next, and the Left and Right arrow keys, show the other files of the list in the same dialog.
 */
export function PreviewDialog({ item, neighbors, onShow, onClose }: PreviewDialogProps) {
	const ownId = useSession().whoami.principal.id;
	const kind = previewKind(item.mime_type, item.size);
	const [content, setContent] = useState<Content>(() => initialContent(kind));
	// The person can go to a different file before a download ends. The state of a download keeps the id
	// of its file, so the busy state and the error show only with that file.
	const [downloadingId, setDownloadingId] = useState<string | null>(null);
	const [downloadError, setDownloadError] = useState<{ itemId: string; message: string } | null>(null);
	const [shownId, setShownId] = useState(item.id);
	const previousRef = useRef<HTMLButtonElement>(null);
	const nextRef = useRef<HTMLButtonElement>(null);
	const downloadRef = useRef<HTMLButtonElement>(null);
	const keyRef = useRef({ neighbors, onShow });
	const { previous, next } = neighbors;

	// A different file: the content of the last file must not show for one frame, so the state resets during the render.
	if (shownId !== item.id) {
		setShownId(item.id);
		setContent(initialContent(kind));
		setDownloadError(null);
	}

	useEffect(() => {
		keyRef.current = { neighbors, onShow };
	});

	// The Left and Right arrow keys show the previous and the next file. The rest of the page is inert,
	// so each key comes from the dialog.
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
			const { neighbors: current, onShow: show } = keyRef.current;
			const target = event.key === "ArrowLeft" ? current.previous : current.next;
			if (!target) return;
			event.preventDefault();
			show(target);
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	// At the first or the last file, the browser removes the button that had the focus. The focus then
	// goes to the other button, so it stays in the dialog.
	useOnChange(item.id, () => {
		if (document.activeElement !== document.body) return;
		(previousRef.current ?? nextRef.current ?? downloadRef.current)?.focus();
	});

	useEffect(() => {
		if (kind === "none") return;
		let active = true;
		let url: string | null = null;
		api.call("drive.download_file", { ...spaceInput(item.space_id, ownId), item_id: item.id }).then(
			(result) => {
				if (!active) return;
				const bytes = base64ToBytes(result.content_base64);
				if (kind === "image") {
					// The type is one of the raster types of previewKind, so the browser reads the bytes as an image only.
					url = URL.createObjectURL(new Blob([bytes], { type: item.mime_type ?? "application/octet-stream" }));
					setContent({ status: "image", url, bytes });
				} else {
					const text = new TextDecoder().decode(bytes);
					setContent({
						status: "text",
						text: text.slice(0, TEXT_PREVIEW_CHARS),
						cut: text.length > TEXT_PREVIEW_CHARS,
						bytes,
					});
				}
			},
			(caught) => {
				if (active) setContent({ status: "error", message: errorMessage(caught) });
			},
		);
		return () => {
			active = false;
			if (url) URL.revokeObjectURL(url);
		};
	}, [kind, item.id, item.space_id, item.mime_type, ownId]);

	async function download() {
		setDownloadError(null);
		// The preview has the bytes already.
		if (content.status === "image" || content.status === "text") {
			saveBytes(content.bytes, item.name);
			return;
		}
		// The person asked for this file, so the file saves also after a move to a different file.
		const itemId = item.id;
		setDownloadingId(itemId);
		try {
			const result = await api.call("drive.download_file", {
				...spaceInput(item.space_id, ownId),
				item_id: itemId,
			});
			saveBytes(base64ToBytes(result.content_base64), result.name);
		} catch (caught) {
			setDownloadError({ itemId, message: errorMessage(caught) });
		} finally {
			setDownloadingId((current) => (current === itemId ? null : current));
		}
	}

	const downloading = downloadingId === item.id;
	const shownError = downloadError?.itemId === item.id ? downloadError.message : null;

	return (
		<Dialog title={item.name} onClose={onClose} className="drive-preview">
			<div className={neighbors.total > 1 ? "drive-preview-body drive-preview-body-nav" : "drive-preview-body"}>
				{neighbors.total > 1 && neighbors.position > 0 && (
					<p className="visually-hidden" role="status">
						{item.name}, file {neighbors.position} of {neighbors.total}
					</p>
				)}
				{content.status === "loading" && (
					<p className="drive-picker-state" role="status">
						<span className="spinner spinner-small" aria-hidden="true" /> Loading the file…
					</p>
				)}
				{content.status === "error" && (
					<p className="form-error" role="alert">
						The file did not load. {content.message}
					</p>
				)}
				{content.status === "image" && <img className="drive-preview-image" src={content.url} alt={item.name} />}
				{content.status === "text" && (
					<div className="drive-preview-sheet">
						{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a keyboard must be able to scroll the text. */}
						<pre className="drive-preview-text" tabIndex={0}>
							{content.text}
						</pre>
						{content.cut && (
							<p className="field-hint">The preview shows the start of the file. Download it to see all.</p>
						)}
					</div>
				)}
				{content.status === "none" && (
					<div className="drive-preview-none">
						<span className="drive-kind drive-kind-large">
							<Icon name={itemIcon(item)} size={18} />
						</span>
						<p>This type of file has no preview.</p>
					</div>
				)}
			</div>
			<div className="drive-preview-footer">
				<dl className="drive-details">
					<div>
						<dt>Type</dt>
						<dd>{item.mime_type ?? "Unknown"}</dd>
					</div>
					<div>
						<dt>Size</dt>
						<dd>{formatBytes(item.size)}</dd>
					</div>
					<div>
						<dt>Last change</dt>
						<dd>
							{fullDate(item.modified_at)}
							{item.modified_by ? `, by ${item.modified_by.display_name}` : ""}
						</dd>
					</div>
				</dl>
				{shownError && (
					<p className="form-error" role="alert">
						{shownError}
					</p>
				)}
				{/* Previous, Download and Next. Above 600px, Previous and Next are at the left and right edges of the
				    file. On a phone, the three buttons are in one row at the bottom, with Download in the center. */}
				<div className="drive-preview-actions">
					{previous && (
						<button
							ref={previousRef}
							type="button"
							className="icon-button drive-preview-nav drive-preview-previous"
							aria-label={`Previous file: ${previous.name}`}
							title="Previous file"
							onClick={() => onShow(previous)}
						>
							<Icon name="chevronLeft" />
						</button>
					)}
					<button
						ref={downloadRef}
						type="button"
						className="button button-primary"
						onClick={() => void download()}
						disabled={downloading}
						data-autofocus
					>
						<Icon name="download" size={16} />
						{downloading ? "Getting the file…" : "Download"}
					</button>
					{next && (
						<button
							ref={nextRef}
							type="button"
							className="icon-button drive-preview-nav drive-preview-next"
							aria-label={`Next file: ${next.name}`}
							title="Next file"
							onClick={() => onShow(next)}
						>
							<Icon name="chevronRight" />
						</button>
					)}
				</div>
			</div>
		</Dialog>
	);
}
