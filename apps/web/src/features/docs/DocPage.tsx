import "./docs.css";
import { ApiError, type DriveItem } from "@soldock/contracts";
import type { Node } from "prosemirror-model";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { saveBytes } from "../../lib/base64.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { DRIVE_PATH } from "../../routes.ts";
import { DocumentHeader, type SaveState } from "../drive/DocumentHeader.tsx";
import { Autosaver, isStalePoll } from "./autosave.ts";
import { DocEditor } from "./DocEditor.tsx";
import { contentToDoc, docToContent } from "./schema.ts";

export interface DocPageProps {
	/** The drive that holds the doc. */
	spaceId: string;
	itemId: string;
}

const POLL_MS = 15_000;

type LoadState =
	| { status: "loading" }
	/** `missing` is true when the doc does not exist, or the person has no access to it. */
	| { status: "error"; message: string; missing: boolean }
	| { status: "ready" };

interface Loaded {
	item: DriveItem;
	/** The document that the editor shows first, and again after each change of `version`. */
	doc: Node;
	version: number;
}

function isConflict(error: unknown): boolean {
	return error instanceof ApiError && error.code === "conflict";
}

/** The file name of the Markdown download. A name that ends with .md keeps it. */
function markdownName(name: string): string {
	return /\.md$/i.test(name) ? name : `${name}.md`;
}

/**
 * The Docs editor for one doc: the header, the formatting toolbar and the text. The page saves each
 * change a short time after it. A viewer can read the doc only.
 */
export function DocPage({ spaceId, itemId }: DocPageProps) {
	const toast = useToast();
	const [load, setLoad] = useState<LoadState>({ status: "loading" });
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [saveState, setSaveState] = useState<SaveState>("saved");
	const [saveError, setSaveError] = useState<string | null>(null);
	const [reloading, setReloading] = useState(false);
	const [downloading, setDownloading] = useState(false);
	/** The newest document of the editor. A save sends it. */
	const docRef = useRef<Node | null>(null);
	const saverRef = useRef<Autosaver | null>(null);
	/** Grows with each request for the doc. Only the answer of the newest request is used. */
	const requestRef = useRef(0);

	/** Gets the doc and shows it. The changes of the editor that are not saved are lost. */
	const open = useCallback(
		async (quiet: boolean) => {
			const request = ++requestRef.current;
			if (!quiet) setLoad({ status: "loading" });
			try {
				const result = await api.call("docs.get", { space_id: spaceId, item_id: itemId });
				if (request !== requestRef.current) return;
				const doc = contentToDoc(result.content);
				docRef.current = doc;
				saverRef.current?.reset(result.revision);
				setLoaded((current) => ({ item: result.item, doc, version: (current?.version ?? 0) + 1 }));
				setLoad({ status: "ready" });
			} catch (caught) {
				if (request !== requestRef.current) return;
				if (quiet) throw caught;
				const missing = caught instanceof ApiError && (caught.code === "not_found" || caught.code === "forbidden");
				setLoad({ status: "error", message: errorMessage(caught), missing });
			}
		},
		[spaceId, itemId],
	);

	// One saver for each doc. When the page closes, it sends the last changes.
	useEffect(() => {
		const saver = new Autosaver({
			save: async (baseRevision) => {
				const doc = docRef.current;
				if (!doc) throw new Error("The doc is not open.");
				const result = await api.call("docs.update", {
					space_id: spaceId,
					item_id: itemId,
					content: docToContent(doc),
					base_revision: baseRevision,
				});
				setLoaded((current) => (current ? { ...current, item: result.item } : current));
				return result.revision;
			},
			isConflict,
			describe: errorMessage,
			onState: (state, error) => {
				setSaveState(state);
				setSaveError(error);
			},
		});
		saverRef.current = saver;
		void open(false);
		return () => {
			requestRef.current += 1;
			void saver.flush();
			saver.dispose();
			saverRef.current = null;
		};
	}, [spaceId, itemId, open]);

	const name = loaded?.item.name ?? null;
	useEffect(() => {
		document.title = `${name ?? "Doc"} – Soldock Docs`;
	}, [name]);

	// While the editor has no changes of its own, it shows the changes of other people and agents.
	useEffect(() => {
		if (load.status !== "ready") return;
		let active = true;
		const refresh = async () => {
			const saver = saverRef.current;
			if (!active || !saver || saver.busy || document.visibilityState !== "visible") return;
			const request = ++requestRef.current;
			const before = saver.revision;
			try {
				const result = await api.call("docs.get", { space_id: spaceId, item_id: itemId });
				// A change in the editor during the request wins: the save then reports a conflict.
				if (!active || request !== requestRef.current || saver.busy) return;
				// A save can start and end during the request. The answer is then older than the text on
				// screen, and it must not replace that text.
				if (isStalePoll(before, saver.revision, result.revision)) return;
				if (result.revision === saver.revision) {
					setLoaded((current) => (current ? { ...current, item: result.item } : current));
					return;
				}
				const doc = contentToDoc(result.content);
				docRef.current = doc;
				saver.reset(result.revision);
				setLoaded((current) => ({ item: result.item, doc, version: (current?.version ?? 0) + 1 }));
			} catch {
				// The next poll tries again. A 401 shows the sign-in page through lib/api.ts.
			}
		};
		const timer = window.setInterval(() => void refresh(), POLL_MS);
		const onFocus = () => void refresh();
		// A hidden tab can close without notice, so it sends its changes at once.
		const onVisibility = () => {
			if (document.visibilityState === "hidden") void saverRef.current?.flush();
			else void refresh();
		};
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			active = false;
			window.clearInterval(timer);
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [load.status, spaceId, itemId]);

	// The browser asks before it closes a tab with changes that the server does not have.
	const unsaved = saveState !== "saved";
	useEffect(() => {
		if (!unsaved) return;
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [unsaved]);

	const onChange = useCallback((doc: Node) => {
		docRef.current = doc;
		saverRef.current?.changed();
	}, []);

	const onItemChange = useCallback((item: DriveItem) => {
		setLoaded((current) => (current ? { ...current, item } : current));
	}, []);

	async function loadNewVersion() {
		setReloading(true);
		try {
			await open(true);
		} catch (caught) {
			toast({ message: `The new version did not load. ${errorMessage(caught)}`, tone: "error" });
		} finally {
			setReloading(false);
		}
	}

	/** Saves the Markdown of the doc as a file, from the server, after the save of the last changes. */
	async function download() {
		setDownloading(true);
		try {
			await saverRef.current?.flush();
			const result = await api.call("docs.get", { space_id: spaceId, item_id: itemId });
			saveBytes(new TextEncoder().encode(result.markdown), markdownName(result.item.name));
			if (saverRef.current?.dirty) {
				toast({ message: "The download does not have your last changes, because they are not saved." });
			}
		} catch (caught) {
			toast({ message: `The download failed. ${errorMessage(caught)}`, tone: "error" });
		} finally {
			setDownloading(false);
		}
	}

	if (load.status === "loading" || (load.status === "ready" && loaded === null)) {
		return (
			<main id="main" className="doc-page" tabIndex={-1}>
				<p className="list-state" role="status">
					<span className="spinner" aria-hidden="true" />
					Loading the doc…
				</p>
			</main>
		);
	}

	if (load.status === "error" || loaded === null) {
		const missing = load.status === "error" && load.missing;
		const message = load.status === "error" ? load.message : "";
		return (
			<main id="main" className="doc-page" tabIndex={-1}>
				<div className="list-state" role="alert">
					<h1 className="doc-state-title">{missing ? "The doc is not available" : "The doc did not load"}</h1>
					<p>{missing ? "This doc does not exist, or you have no access to it." : message}</p>
					<p className="doc-state-actions">
						{!missing && (
							<button type="button" className="button button-primary" onClick={() => void open(false)}>
								Try again
							</button>
						)}
						<Link to={DRIVE_PATH} className="button">
							Go to Drive
						</Link>
					</p>
				</div>
			</main>
		);
	}

	const { item } = loaded;
	// The server refuses a change to a doc in the trash, so its owner gets the text read-only too.
	const editable = item.role !== "viewer" && !item.trashed;

	return (
		<main id="main" className="doc-page" tabIndex={-1}>
			<DocumentHeader
				item={item}
				saveState={editable ? saveState : null}
				onItemChange={onItemChange}
				actions={
					<button
						type="button"
						className="icon-button"
						aria-label="Download as Markdown"
						title="Download as Markdown"
						onClick={() => void download()}
						disabled={downloading}
					>
						<Icon name="download" />
					</button>
				}
			/>
			{editable && saveState === "conflict" && (
				<div className="doc-notice doc-notice-warning" role="alert">
					<Icon name="warning" />
					<p>
						Somebody changed this doc after you opened it, so your last changes cannot be saved. Copy the text that you
						want to keep. Then load the new version: the changes that are not saved are lost.
					</p>
					<button type="button" className="button" onClick={() => void loadNewVersion()} disabled={reloading}>
						{reloading ? "Loading…" : "Load the new version"}
					</button>
				</div>
			)}
			{editable && saveState === "error" && (
				<div className="doc-notice doc-notice-error" role="alert">
					<Icon name="warning" />
					<p>
						Your last changes are not saved. {saveError} The editor keeps them and tries again after the next change.
					</p>
					<button type="button" className="button" onClick={() => void saverRef.current?.flush()}>
						Try again
					</button>
				</div>
			)}
			{!editable && (
				<p className="doc-notice" role="note">
					<Icon name="eye" />
					<span>You can read this doc. Only the owner and editors can change it.</span>
				</p>
			)}
			<DocEditor
				doc={loaded.doc}
				version={loaded.version}
				editable={editable && saveState !== "conflict"}
				label={`Text of ${item.name}`}
				onChange={onChange}
			/>
		</main>
	);
}
