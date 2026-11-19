import { CHAT_LIMITS } from "@asterra/contracts";
import { useRef } from "react";
import { formatBytes } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import type { Attachment } from "./attachments.ts";

// The files of a message in the box: the attach button, and a chip for each file with its progress.

/** The button that opens the file dialog of the browser. A message takes at most 10 files. */
export function AttachButton({ count, onFiles }: { count: number; onFiles: (files: File[]) => void }) {
	const input = useRef<HTMLInputElement>(null);
	const full = count >= CHAT_LIMITS.filesPerMessage;
	return (
		<>
			<button
				type="button"
				className="icon-button chat-attach"
				aria-label={full ? `Attach files: the message has ${CHAT_LIMITS.filesPerMessage} files` : "Attach files"}
				title={full ? `A message can have at most ${CHAT_LIMITS.filesPerMessage} files` : "Attach files"}
				disabled={full}
				onClick={() => input.current?.click()}
			>
				<Icon name="paperclip" size={18} />
			</button>
			<input
				ref={input}
				type="file"
				multiple
				hidden
				tabIndex={-1}
				onChange={(event) => {
					const files = [...(event.target.files ?? [])];
					event.target.value = "";
					if (files.length > 0) onFiles(files);
				}}
			/>
		</>
	);
}

function progressOf(file: Attachment): number {
	return file.size > 0 ? Math.min(100, Math.floor((file.sent * 100) / file.size)) : 0;
}

/**
 * A chip for each file of the box: the name, the size, a bar while it uploads, the reason and "Try again"
 * after a failure, and a button that cancels the upload or removes the file. `busy` keeps the files while
 * a send runs.
 */
export function AttachmentChips({
	files,
	notice,
	busy = false,
	onRetry,
	onRemove,
}: {
	files: readonly Attachment[];
	notice: string | null;
	busy?: boolean;
	onRetry: (key: string) => void;
	onRemove: (key: string) => void;
}) {
	if (files.length === 0 && notice === null) return null;
	return (
		<div className="chat-attachments">
			{files.length > 0 && (
				<ul className="chat-attachment-list" aria-label="Files of the message">
					{files.map((file) => {
						const progress = progressOf(file);
						return (
							<li key={file.key} className={`chat-attachment chat-attachment-${file.state}`}>
								<span className="chat-attachment-icon" aria-hidden="true">
									<Icon name={file.state === "failed" ? "warning" : /^image\//.test(file.type) ? "image" : "file"} size={16} />
								</span>
								<span className="chat-attachment-text">
									<span className="chat-attachment-name" title={file.name}>
										{file.name}
									</span>
									<span className="chat-attachment-detail">
										{file.state === "failed"
											? `Not uploaded. ${file.error ?? ""}`
											: file.state === "uploading"
												? `${formatBytes(file.sent)} of ${formatBytes(file.size)}`
												: formatBytes(file.size)}
									</span>
									{file.state === "uploading" && (
										<span
											className="chat-attachment-bar"
											role="progressbar"
											aria-label={`Upload of ${file.name}`}
											aria-valuemin={0}
											aria-valuemax={100}
											aria-valuenow={progress}
											aria-valuetext={`${progress}%, ${formatBytes(file.sent)} of ${formatBytes(file.size)}`}
										>
											<span className="chat-attachment-fill" style={{ width: `${progress}%` }} />
										</span>
									)}
								</span>
								{file.state === "failed" && (
									<button
										type="button"
										className="icon-button icon-button-small"
										aria-label={`Try the upload of ${file.name} again`}
										title="Try again"
										onClick={() => onRetry(file.key)}
									>
										<Icon name="refresh" size={16} />
									</button>
								)}
								<button
									type="button"
									className="icon-button icon-button-small"
									aria-label={file.state === "uploading" ? `Cancel the upload of ${file.name}` : `Remove ${file.name}`}
									title={file.state === "uploading" ? "Cancel the upload" : "Remove"}
									disabled={busy}
									onClick={() => onRemove(file.key)}
								>
									<Icon name="close" size={16} />
								</button>
							</li>
						);
					})}
				</ul>
			)}
			{notice !== null && (
				<p className="chat-attachments-notice" role="alert">
					{notice}
				</p>
			)}
		</div>
	);
}
