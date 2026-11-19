import { type ChatFile, type ChatMessage, chatFilePath } from "@asterra/contracts";
import { useState } from "react";
import { formatBytes } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useFocusAfterRemove } from "./focusAfterRemove.ts";
import { fileDisplay, linkPreviewCards } from "./model.ts";

// The files and the link previews of a message. Each file comes from `/dl/chat/…` with the session
// cookie: the server sends a picture or a video inline only when it found that type in the bytes, and
// each other file as an attachment. A link preview is content from outside the organization: its texts
// are React text nodes, and its picture comes from the server, never from the site of the link.

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
 * One file of a stored message, as `fileDisplay` tells. A picture opens the file in a new tab. A video
 * plays in the page. A picture or a video that does not load (its author removed it from Drive, for
 * example) shows as a chip with a note, until its address changes.
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
	const url = chatFilePath(roomId, messageId, file.item_id);
	const display = fileDisplay(file);
	const src = display.as !== "chip" && display.preview ? chatFilePath(roomId, messageId, file.item_id, "preview") : url;
	/** The address that did not load. A new address (a new small picture, for example) tries again. */
	const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
	if (display.as === "chip" || brokenSrc === src) {
		return <FileChip file={file} url={url} {...(brokenSrc === src ? { note: "The file does not load now." } : {})} />;
	}
	const fixed = display.preview ? "" : " chat-file-media-fixed";
	if (display.as === "image") {
		return (
			<figure className={`chat-file-media${fixed}`}>
				<a href={url} target="_blank" rel="noopener noreferrer" className="chat-file-image" title="Open in a new tab">
					<img
						src={src}
						alt={file.name}
						width={display.box.width}
						height={display.box.height}
						loading="lazy"
						decoding="async"
						onLoad={onMediaLoad}
						onError={() => setBrokenSrc(src)}
					/>
				</a>
				<MediaCaption file={file} url={url} />
			</figure>
		);
	}
	return (
		<figure className={`chat-file-media${fixed}`}>
			{/* biome-ignore lint/a11y/useMediaCaption: a member uploaded the video, and the file has no captions. */}
			<video
				className="chat-file-video"
				controls
				preload="metadata"
				poster={display.preview ? src : undefined}
				src={url}
				width={display.box.width}
				height={display.box.height}
				aria-label={file.name}
				onLoadedMetadata={onMediaLoad}
				onError={() => setBrokenSrc(src)}
			/>
			<MediaCaption file={file} url={url} />
		</figure>
	);
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
 * The previews of the links of a message (`linkPreviewCards`): the site, the title as a link, the
 * description and the picture. The author removes a preview with the X. After the X, the focus goes to
 * the next preview, or to `onFocusAway`.
 */
export function LinkPreviews({
	message,
	ownId,
	pending,
	onRemove,
	onFocusAway,
	onMediaLoad,
}: {
	message: Pick<ChatMessage, "id" | "room_id" | "author" | "link_previews">;
	ownId: string;
	pending: boolean;
	onRemove: (url: string) => void;
	onFocusAway: () => void;
	onMediaLoad?: (() => void) | undefined;
}) {
	const cards = linkPreviewCards(message, { ownId, pending });
	const focus = useFocusAfterRemove(cards, (card) => card.url, onFocusAway);
	if (cards.length === 0) return null;
	return (
		<ul className="chat-link-previews" aria-label="Link previews" ref={focus.list}>
			{cards.map((card, index) => (
				<li key={card.url} className="chat-link-preview">
					<div className="chat-link-preview-text">
						{card.site && <p className="chat-link-preview-site">{card.site}</p>}
						<p className="chat-link-preview-title">
							{card.href ? (
								<a href={card.href} target="_blank" rel={card.rel} className="chat-link">
									{card.title}
								</a>
							) : (
								card.title
							)}
						</p>
						{card.description && <p className="chat-link-preview-description">{card.description}</p>}
					</div>
					{card.image && (
						<img
							className="chat-link-preview-image"
							src={card.image.src}
							alt=""
							width={card.image.width}
							height={card.image.height}
							loading="lazy"
							decoding="async"
							onLoad={onMediaLoad}
						/>
					)}
					{card.removable && (
						<button
							type="button"
							data-remove
							className="icon-button icon-button-small chat-link-preview-remove"
							aria-label={`Remove the preview of ${card.title}`}
							title="Remove the preview"
							onClick={() => {
								focus.removing(card.url, index);
								onRemove(card.url);
							}}
						>
							<Icon name="close" size={14} />
						</button>
					)}
				</li>
			))}
		</ul>
	);
}

/**
 * The files of a message in its edit box. The author removes a file with the X. After the X, the focus
 * goes to the next file, or to `onFocusAway` (the edit box).
 */
export function EditFiles({
	files,
	onRemove,
	onFocusAway,
}: {
	files: readonly ChatFile[];
	onRemove: (itemId: string) => void;
	onFocusAway: () => void;
}) {
	const focus = useFocusAfterRemove(files, (file) => file.item_id, onFocusAway);
	if (files.length === 0) return null;
	return (
		<ul className="chat-attachment-list chat-edit-files" aria-label="Files of the message" ref={focus.list}>
			{files.map((file, index) => (
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
						data-remove
						className="icon-button icon-button-small"
						aria-label={`Remove ${file.name} from the message`}
						title="Remove from the message"
						onClick={() => {
							focus.removing(file.item_id, index);
							onRemove(file.item_id);
						}}
					>
						<Icon name="close" size={16} />
					</button>
				</li>
			))}
		</ul>
	);
}
