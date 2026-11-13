import type { DriveItem } from "@soldock/contracts";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { base64ToBytes, saveBytes } from "../../lib/base64.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { formatBytes, fullDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useSession } from "../auth/session.tsx";
import { itemIcon, previewKind, spaceInput } from "./model.ts";

/** The characters of a text file that the preview shows. */
const TEXT_PREVIEW_CHARS = 200_000;

type Content =
	| { status: "none" }
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "image"; url: string; bytes: Uint8Array<ArrayBuffer> }
	| { status: "text"; text: string; cut: boolean; bytes: Uint8Array<ArrayBuffer> };

/**
 * Shows a file. A raster image shows from a `blob:` URL, and text shows as plain text. The content
 * of a file never goes into the page as HTML. Each other type shows its details and a download.
 */
export function PreviewDialog({ item, onClose }: { item: DriveItem; onClose: () => void }) {
	const ownId = useSession().whoami.principal.id;
	const kind = previewKind(item.mime_type, item.size);
	const [content, setContent] = useState<Content>(kind === "none" ? { status: "none" } : { status: "loading" });
	const [downloading, setDownloading] = useState(false);
	const [downloadError, setDownloadError] = useState<string | null>(null);

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
		setDownloading(true);
		try {
			const result = await api.call("drive.download_file", {
				...spaceInput(item.space_id, ownId),
				item_id: item.id,
			});
			saveBytes(base64ToBytes(result.content_base64), result.name);
		} catch (caught) {
			setDownloadError(errorMessage(caught));
		} finally {
			setDownloading(false);
		}
	}

	return (
		<Dialog title={item.name} onClose={onClose} className="drive-preview">
			<div className="dialog-body drive-preview-body">
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
					<>
						{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a keyboard must be able to scroll the text. */}
						<pre className="drive-preview-text" tabIndex={0}>
							{content.text}
						</pre>
						{content.cut && (
							<p className="field-hint">The preview shows the start of the file. Download it to see all.</p>
						)}
					</>
				)}
				{content.status === "none" && (
					<div className="drive-preview-none">
						<Icon name={itemIcon(item)} size={48} />
						<p>This type of file has no preview.</p>
					</div>
				)}
				<dl className="drive-details">
					<dt>Type</dt>
					<dd>{item.mime_type ?? "Unknown"}</dd>
					<dt>Size</dt>
					<dd>{formatBytes(item.size)}</dd>
					<dt>Last change</dt>
					<dd>
						{fullDate(item.modified_at)}
						{item.modified_by ? `, by ${item.modified_by.display_name}` : ""}
					</dd>
				</dl>
				{downloadError && (
					<p className="form-error" role="alert">
						{downloadError}
					</p>
				)}
			</div>
			<div className="dialog-actions">
				<button type="button" className="button" onClick={onClose}>
					Close
				</button>
				<button
					type="button"
					className="button button-primary"
					onClick={() => void download()}
					disabled={downloading}
					data-autofocus
				>
					<Icon name="download" size={16} />
					{downloading ? "Getting the file…" : "Download"}
				</button>
			</div>
		</Dialog>
	);
}
