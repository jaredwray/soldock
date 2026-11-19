import { type ChatFile, type ChatLinkPreview, chatFilePath, chatLinkImagePath } from "@asterra/contracts";
import { useState } from "react";
import { formatBytes } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { fitBox, safeLinkPreviewHref } from "./model.ts";

// The files and the link previews of a message. Each file comes from `/dl/chat/…` with the session
// cookie: the server sends a picture or a video inline only when it found that type in the bytes, and
// each other file as an attachment. A link preview is content from outside the organization: its texts
// are React text nodes, and its picture comes from the server, never from the site of the link.

/** The largest box of a picture or a video in a message, in CSS pixels. */
const MEDIA_BOX = { width: 360, height: 280 };
/** The largest box of the picture of a link preview. */
const LINK_IMAGE_BOX = { width: 96, height: 96 };

/** The name, the size and the download link under a picture or a video. */
function MediaCaption({ file, url }: { file: ChatFile; url: string }) {
	return (
		<figcaption className="chat-file-caption">
			<span className="chat-file-caption-name" title={file.name}>
				{file.name}
			</span>
			<span className="chat-file-caption-size">{formatBytes(file.size)}</span>
			<a
				className="icon-button icon-button-small"
				href={url}
				download={file.name}
				aria-label={`Download ${file.name}`}
				title="Download"
			>
				<Icon name="download" size={16} />
			</a>
		</figcaption>
	);
}

/** A file as a chip: an icon, the name and the size, and a download link when the message has an id. */
function FileChip({ file, url, note }: { file: ChatFile; url: string | null; note?: string }) {
	const content = (
		<>
			<span className="chat-file-icon" aria-hidden="true">
				<Icon name={file.kind === "image" ? "image" : "file"} size={18} />
			</span>
			<span className="chat-file-text">
				<span className="chat-file-name">{file.name}</span>
				<span className="chat-file-size">{note ?? formatBytes(file.size)}</span>
			</span>
		</>
	);
	if (url === null) return <span className="chat-file">{content}</span>;
	return (
		<a className="chat-file chat-file-link" href={url} download={file.name} title={`Download ${file.name}`}>
			{content}
			<Icon name="download" size={16} />
		</a>
	);
}

/**
 * One file of a stored message. A picture shows its small picture, or the file without one, and opens
 * the file in a new tab. A video plays in the page. A file that does not load (its author removed it
 * from Drive, for example) shows as a chip with a note.
 */
function MessageFile({
	file,
	roomId,
	messageId,
	onMediaLoad,
}: {
	file: ChatFile;
	roomId: string;
	messageId: string;
	onMediaLoad?: (() => void) | undefined;
}) {
	const [broken, setBroken] = useState(false);
	const url = chatFilePath(roomId, messageId, file.item_id);
	if (broken) return <FileChip file={file} url={url} note="The file does not load now." />;
	// The size of the small picture gives the box before the picture loads, so the list does not move.
	const box = file.preview ? fitBox(file.preview, MEDIA_BOX) : null;
	const poster = file.preview ? chatFilePath(roomId, messageId, file.item_id, "preview") : undefined;
	if (file.kind === "image") {
		return (
			<figure className="chat-file-media">
				<a href={url} target="_blank" rel="noopener noreferrer" className="chat-file-image" title="Open in a new tab">
					<img
						src={poster ?? url}
						alt={file.name}
						width={box?.width}
						height={box?.height}
						loading="lazy"
						decoding="async"
						onLoad={onMediaLoad}
						onError={() => setBroken(true)}
					/>
				</a>
				<MediaCaption file={file} url={url} />
			</figure>
		);
	}
	if (file.kind === "video") {
		return (
			<figure className="chat-file-media">
				{/* biome-ignore lint/a11y/useMediaCaption: a member uploaded the video, and the file has no captions. */}
				<video
					className="chat-file-video"
					controls
					preload="metadata"
					poster={poster}
					src={url}
					width={box?.width}
					height={box?.height}
					aria-label={file.name}
					onLoadedMetadata={onMediaLoad}
					onError={() => setBroken(true)}
				/>
				<MediaCaption file={file} url={url} />
			</figure>
		);
	}
	return <FileChip file={file} url={url} />;
}

/**
 * The files of a message, under its text. A message that waits for the server has no id yet, so its
 * files show as chips without a link. `onMediaLoad` runs when a picture or a video gets its size, so the
 * list can keep its place.
 */
export function MessageFiles({
	files,
	roomId,
	messageId,
	pending,
	onMediaLoad,
}: {
	files: readonly ChatFile[];
	roomId: string;
	messageId: string;
	pending: boolean;
	onMediaLoad?: (() => void) | undefined;
}) {
	if (files.length === 0) return null;
	return (
		<ul className="chat-files" aria-label="Files">
			{files.map((file) => (
				<li key={file.item_id}>
					{pending ? (
						<FileChip file={file} url={null} />
					) : (
						<MessageFile file={file} roomId={roomId} messageId={messageId} onMediaLoad={onMediaLoad} />
					)}
				</li>
			))}
		</ul>
	);
}

/**
 * The previews of the links of a message: the site, the title as a link, the description and the
 * picture. The author removes a preview with the X (`onRemove`). Null for each other person.
 */
export function LinkPreviews({
	previews,
	roomId,
	messageId,
	onRemove,
	onMediaLoad,
}: {
	previews: readonly ChatLinkPreview[];
	roomId: string;
	messageId: string;
	onRemove: ((url: string) => void) | null;
	onMediaLoad?: (() => void) | undefined;
}) {
	if (previews.length === 0) return null;
	return (
		<ul className="chat-link-previews" aria-label="Link previews">
			{previews.map((preview) => {
				const href = safeLinkPreviewHref(preview.url);
				const title = preview.title ?? preview.url;
				const box = preview.image ? fitBox(preview.image, LINK_IMAGE_BOX) : null;
				return (
					<li key={preview.url} className="chat-link-preview">
						<div className="chat-link-preview-text">
							{preview.site_name && <p className="chat-link-preview-site">{preview.site_name}</p>}
							<p className="chat-link-preview-title">
								{href ? (
									<a href={href} target="_blank" rel="noopener noreferrer nofollow" className="chat-link">
										{title}
									</a>
								) : (
									title
								)}
							</p>
							{preview.description && <p className="chat-link-preview-description">{preview.description}</p>}
						</div>
						{box && (
							<img
								className="chat-link-preview-image"
								src={chatLinkImagePath(roomId, messageId, preview.url)}
								alt=""
								width={box.width}
								height={box.height}
								loading="lazy"
								decoding="async"
								onLoad={onMediaLoad}
							/>
						)}
						{onRemove && (
							<button
								type="button"
								className="icon-button icon-button-small chat-link-preview-remove"
								aria-label={`Remove the preview of ${title}`}
								title="Remove the preview"
								onClick={() => onRemove(preview.url)}
							>
								<Icon name="close" size={14} />
							</button>
						)}
					</li>
				);
			})}
		</ul>
	);
}

/** The files of a message in its edit box. The author removes a file with the X. */
export function EditFiles({ files, onRemove }: { files: readonly ChatFile[]; onRemove: (itemId: string) => void }) {
	if (files.length === 0) return null;
	return (
		<ul className="chat-attachment-list chat-edit-files" aria-label="Files of the message">
			{files.map((file) => (
				<li key={file.item_id} className="chat-attachment chat-attachment-ready">
					<span className="chat-attachment-icon" aria-hidden="true">
						<Icon name={file.kind === "image" ? "image" : "file"} size={16} />
					</span>
					<span className="chat-attachment-text">
						<span className="chat-attachment-name" title={file.name}>
							{file.name}
						</span>
						<span className="chat-attachment-detail">{formatBytes(file.size)}</span>
					</span>
					<button
						type="button"
						className="icon-button icon-button-small"
						aria-label={`Remove ${file.name} from the message`}
						title="Remove from the message"
						onClick={() => onRemove(file.item_id)}
					>
						<Icon name="close" size={16} />
					</button>
				</li>
			))}
		</ul>
	);
}
