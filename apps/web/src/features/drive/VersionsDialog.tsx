import type { DriveItem, FileVersion } from "@soldock/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fileToBase64 } from "../../lib/base64.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { formatBytes, fullDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useSession } from "../auth/session.tsx";
import { downloadFile } from "./data.ts";
import { spaceInput, uploadMimeType, uploadRefusal } from "./model.ts";

/**
 * The versions of a file. Each person with access can get a version. An owner or an editor can
 * upload a new version and make an older version the current version.
 */
export function VersionsDialog({
	item,
	onClose,
	onChanged,
}: {
	item: DriveItem;
	onClose: () => void;
	onChanged: () => void;
}) {
	const ownId = useSession().whoami.principal.id;
	const [versions, setVersions] = useState<FileVersion[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const canEdit = item.role === "owner" || item.role === "editor";
	const space = spaceInput(item.space_id, ownId);

	const load = useCallback(async () => {
		try {
			const result = await api.call("drive.list_versions", {
				...spaceInput(item.space_id, ownId),
				item_id: item.id,
			});
			setVersions(result.versions);
			setLoadError(null);
		} catch (caught) {
			setLoadError(errorMessage(caught));
		}
	}, [item.id, item.space_id, ownId]);

	useEffect(() => {
		void load();
	}, [load]);

	/** Runs one action. `label` shows in the status line while it runs. */
	async function run(label: string, action: () => Promise<void>) {
		setBusy(label);
		setError(null);
		try {
			await action();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(null);
		}
	}

	function upload(file: File) {
		const refusal = uploadRefusal(file);
		if (refusal) {
			setError(refusal);
			return;
		}
		void run("Uploading the new version…", async () => {
			const mimeType = uploadMimeType(file.type);
			await api.call("drive.upload_version", {
				...space,
				item_id: item.id,
				...(mimeType ? { mime_type: mimeType } : {}),
				content_base64: await fileToBase64(file),
			});
			await load();
			onChanged();
		});
	}

	function restore(version: FileVersion) {
		void run("Changing the current version…", async () => {
			await api.call("drive.restore_version", { ...space, item_id: item.id, version_id: version.id });
			await load();
			onChanged();
		});
	}

	return (
		<Dialog title={`Versions of “${item.name}”`} onClose={onClose}>
			<div className="dialog-body">
				{versions === null && loadError === null && (
					<p className="drive-picker-state" role="status">
						<span className="spinner spinner-small" aria-hidden="true" /> Loading versions…
					</p>
				)}
				{loadError !== null && versions === null && (
					<p className="form-error" role="alert">
						The versions did not load. {loadError}{" "}
						<button type="button" className="link-button" onClick={() => void load()}>
							Try again
						</button>
					</p>
				)}
				{versions !== null && (
					<ul className="drive-version-list">
						{versions.map((version) => (
							<li key={version.id} className="drive-version">
								<span className="drive-version-text">
									<strong>
										{fullDate(version.created_at)}
										{version.current && <span className="chip chip-small drive-version-current">Current</span>}
									</strong>
									<span className="muted">
										{formatBytes(version.size)}
										{version.created_by ? `, by ${version.created_by.display_name}` : ""}
									</span>
								</span>
								<button
									type="button"
									className="icon-button icon-button-small"
									aria-label={`Download the version of ${fullDate(version.created_at)}`}
									title="Download"
									disabled={busy !== null}
									onClick={() => void run("Getting the version…", () => downloadFile(item, ownId, version.id))}
								>
									<Icon name="download" size={18} />
								</button>
								{canEdit && !version.current && (
									<button
										type="button"
										className="button button-small"
										disabled={busy !== null}
										onClick={() => restore(version)}
									>
										Make current
									</button>
								)}
							</li>
						))}
					</ul>
				)}
				<p className="drive-version-status" role="status">
					{busy}
				</p>
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
			</div>
			<div className="dialog-actions">
				{canEdit && (
					<>
						<input
							ref={fileRef}
							type="file"
							hidden
							onChange={(event) => {
								const file = event.target.files?.[0];
								event.target.value = "";
								if (file) upload(file);
							}}
						/>
						<button type="button" className="button" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
							<Icon name="upload" size={16} />
							Upload new version
						</button>
					</>
				)}
				<button type="button" className="button button-primary" onClick={onClose} data-autofocus>
					Done
				</button>
			</div>
		</Dialog>
	);
}
