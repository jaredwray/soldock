import "./sheets.css";
import { ApiError } from "@soldock/contracts";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Link } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { DRIVE_PATH } from "../../routes.ts";
import { DocumentHeader } from "../drive/DocumentHeader.tsx";
import type { CellChange } from "./cells.ts";
import { newTabMemory, SheetEditor, type TabMemory } from "./SheetEditor.tsx";
import { SheetTabs, tabElementId } from "./SheetTabs.tsx";
import { SheetStore, type TabAction, type TabsData } from "./store.ts";

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
	const store = useMemo(() => {
		const sheet = { space_id: spaceId, item_id: itemId };
		const changeTab = (action: TabAction): Promise<TabsData> => {
			switch (action.kind) {
				case "add":
					return api.call("sheets.add_tab", sheet);
				case "rename":
					return api.call("sheets.rename_tab", { ...sheet, tab_id: action.tabId, name: action.name });
				case "move":
					return api.call("sheets.move_tab", { ...sheet, tab_id: action.tabId, index: action.index });
				case "duplicate":
					return api.call("sheets.duplicate_tab", { ...sheet, tab_id: action.tabId });
				case "delete":
					return api.call("sheets.delete_tab", { ...sheet, tab_id: action.tabId });
			}
		};
		return new SheetStore({
			get: (tabId) => api.call("sheets.get", { ...sheet, tab_id: tabId }),
			update: (cells, baseRevision, tabId) =>
				api.call("sheets.update_cells", { ...sheet, tab_id: tabId, cells, base_revision: baseRevision }),
			changeTab,
		});
	}, [spaceId, itemId]);
	const sheet = useSyncExternalStore(store.subscribe, store.getSnapshot);
	const [discarding, setDiscarding] = useState(false);
	const name = sheet.item?.name ?? null;
	const baseId = useId();
	const panelId = useId();
	/** The selection, Undo and Redo, and the scroll position of each tab. */
	const memories = useRef(new Map<string, TabMemory>());

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

	const activeTab = sheet.activeTab;
	const inputOf = useCallback((cell: string) => store.inputOf(cell, activeTab), [store, activeTab]);
	const commit = useCallback((changes: CellChange[]) => store.commit(changes, activeTab), [store, activeTab]);
	const changeTab = useCallback((action: TabAction) => store.changeTab(action), [store]);
	/** The name of each tab in the last snapshot, to find a rename. */
	const namesRef = useRef(new Map<string, string>());

	useEffect(() => {
		// The Undo steps of each tab hold tab names in their formulas. After a rename, of this page or of
		// somebody else, Undo would write the old name back and give #REF!, so a rename clears them.
		const before = namesRef.current;
		if (sheet.tabs.some((tab) => before.has(tab.id) && before.get(tab.id) !== tab.name)) {
			for (const memory of memories.current.values()) memory.history = { undo: [], redo: [] };
		}
		namesRef.current = new Map(sheet.tabs.map((tab) => [tab.id, tab.name]));
		// The memory of a deleted tab is not needed again: a new tab never gets its id.
		for (const id of memories.current.keys()) if (!namesRef.current.has(id)) memories.current.delete(id);
	}, [sheet.tabs]);

	function memoryOf(tabId: string): TabMemory {
		let memory = memories.current.get(tabId);
		if (!memory) {
			memory = newTabMemory();
			memories.current.set(tabId, memory);
		}
		return memory;
	}

	/** Shows the next tab or the tab before, from a keyboard shortcut in the grid. The grid of that tab gets the focus. */
	function switchTab(step: 1 | -1) {
		const index = sheet.tabs.findIndex((tab) => tab.id === activeTab);
		const next = sheet.tabs[index + step];
		if (!next) return;
		memoryOf(next.id).focusOnOpen = true;
		store.selectTab(next.id);
	}

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

	// The server refuses a change to a sheet in the trash, so its owner gets the grid read-only too.
	const readOnly = sheet.item.role === "viewer" || sheet.item.trashed;
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
			<div role="tabpanel" id={panelId} aria-labelledby={tabElementId(baseId, activeTab)} className="sheet-panel">
				<SheetEditor
					// Each tab gets its own editor, with the selection and the Undo steps of that tab.
					key={activeTab}
					name={`${sheet.item.name}, ${sheet.tabs.find((tab) => tab.id === activeTab)?.name ?? ""}`}
					cells={sheet.cells}
					readOnly={readOnly}
					loading={sheet.tabLoading}
					memory={memoryOf(activeTab)}
					onSwitchTab={switchTab}
					inputOf={inputOf}
					onCommit={commit}
				/>
			</div>
			<SheetTabs
				baseId={baseId}
				panelId={panelId}
				tabs={sheet.tabs}
				activeTab={activeTab}
				readOnly={readOnly}
				onSelect={(tabId) => store.selectTab(tabId)}
				onChange={changeTab}
			/>
		</main>
	);
}
