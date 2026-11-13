import "./sheets.css";
import { ApiError } from "@soldock/contracts";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Link } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { DRIVE_PATH } from "../../routes.ts";
import { DocumentHeader } from "../drive/DocumentHeader.tsx";
import type { CellChange } from "./cells.ts";
import { SheetEditor } from "./SheetEditor.tsx";
import { SheetStore } from "./store.ts";

export interface SheetPageProps {
	/** The drive that holds the sheet. */
	spaceId: string;
	itemId: string;
}

const REFRESH_MS = 15_000;

/**
 * The Sheets editor for one sheet. The server calculates each formula: the page sends the inputs
 * that change and shows the results that come back.
 */
export function SheetPage({ spaceId, itemId }: SheetPageProps) {
	const toast = useToast();
	const store = useMemo(
		() =>
			new SheetStore({
				get: () => api.call("sheets.get", { space_id: spaceId, item_id: itemId }),
				update: (cells, baseRevision) =>
					api.call("sheets.update_cells", { space_id: spaceId, item_id: itemId, cells, base_revision: baseRevision }),
			}),
		[spaceId, itemId],
	);
	const sheet = useSyncExternalStore(store.subscribe, store.getSnapshot);
	const [discarding, setDiscarding] = useState(false);
	const name = sheet.item?.name ?? null;

	useEffect(() => {
		void store.load();
	}, [store]);

	useEffect(() => {
		document.title = `${name ?? "Sheet"} – Soldock Sheets`;
	}, [name]);

	// Other people can change the sheet. While no change of this page waits, get the sheet again
	// every 15 seconds when the tab is visible, and when the window gets the focus.
	useEffect(() => {
		const refresh = () => {
			if (document.visibilityState === "visible") void store.refresh();
		};
		const timer = window.setInterval(refresh, REFRESH_MS);
		window.addEventListener("focus", refresh);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("focus", refresh);
		};
	}, [store]);

	// The browser asks before it closes a tab that has a change that the server does not have.
	useEffect(() => {
		const warn = (event: BeforeUnloadEvent) => {
			if (store.hasUnsaved()) event.preventDefault();
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [store]);

	const inputOf = useCallback((cell: string) => store.inputOf(cell), [store]);
	const commit = useCallback((changes: CellChange[]) => store.commit(changes), [store]);

	async function discard() {
		setDiscarding(true);
		try {
			await store.discard();
		} catch (error) {
			toast({ message: `The sheet did not load. ${errorMessage(error)}`, tone: "error" });
		} finally {
			setDiscarding(false);
		}
	}

	if (sheet.status === "loading" || (sheet.status === "ready" && !sheet.item)) {
		return (
			<main id="main" className="page" tabIndex={-1}>
				<p className="list-state" role="status">
					<span className="spinner" aria-hidden="true" />
					Loading the sheet…
				</p>
			</main>
		);
	}

	if (sheet.status === "error" || !sheet.item) {
		const missing = sheet.loadError instanceof ApiError && sheet.loadError.code === "not_found";
		return (
			<main id="main" className="page" tabIndex={-1}>
				<div className="list-state" role="alert">
					{missing ? (
						<>
							<p>This sheet does not exist, or you have no access to it.</p>
							<Link to={DRIVE_PATH} className="button">
								Go to Drive
							</Link>
						</>
					) : (
						<>
							<p>The sheet did not load. {errorMessage(sheet.loadError)}</p>
							<button type="button" className="button" onClick={() => void store.load()}>
								Try again
							</button>
						</>
					)}
				</div>
			</main>
		);
	}

	const readOnly = sheet.item.role === "viewer";
	const saveFailed = !readOnly && (sheet.saveState === "error" || sheet.saveState === "conflict");

	return (
		<main id="main" className="sheet-page" tabIndex={-1}>
			<DocumentHeader
				item={sheet.item}
				saveState={readOnly ? null : sheet.saveState}
				onItemChange={(item) => store.setItem(item)}
			/>
			{saveFailed && (
				<div className="sheet-save-error" role="alert">
					<p>
						{sheet.saveState === "conflict"
							? "Somebody changed this sheet at the same time. Your last changes are not saved."
							: `Your last changes are not saved. ${errorMessage(sheet.saveError)}`}
					</p>
					<button type="button" className="button button-small" onClick={() => store.retry()} disabled={discarding}>
						Try again
					</button>
					<button type="button" className="button button-small" onClick={() => void discard()} disabled={discarding}>
						Discard my changes
					</button>
				</div>
			)}
			<SheetEditor name={sheet.item.name} cells={sheet.cells} readOnly={readOnly} inputOf={inputOf} onCommit={commit} />
		</main>
	);
}
