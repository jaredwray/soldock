import { ApiError, type Cell, type DriveItem, SHEET_LIMITS, type Tab } from "@soldock/contracts";
import type { SaveState } from "../drive/DocumentHeader.tsx";
import { applyCells, type CellChange, toCellMap, type ViewCell, viewCells } from "./cells.ts";

// The state of one open sheet: its tabs, the cells of each tab from the server, the changes that
// wait for the server, and the save queue. The store has no DOM use. The page gives it the calls that
// it needs.

/** One tab of a sheet as `sheets.get` and `sheets.update_cells` return it. */
export interface SheetData {
	item: DriveItem;
	revision: number;
	tabs: Tab[];
	/** The tab of `cells`. */
	tab_id: string;
	cells: Cell[];
}

/** The answer of an operation that changes the tabs. `tab_id` is the new tab of an add or a copy. */
export interface TabsData {
	item: DriveItem;
	revision: number;
	tabs: Tab[];
	tab_id?: string;
}

/** A change to the tabs, as the tab bar asks for it. */
export type TabAction =
	| { kind: "add" }
	| { kind: "rename"; tabId: string; name: string }
	| { kind: "move"; tabId: string; index: number }
	| { kind: "duplicate"; tabId: string }
	| { kind: "delete"; tabId: string };

export interface SheetApi {
	/** `sheets.get`: each cell of a tab. Without a tab, the first tab. */
	get(tabId?: string): Promise<SheetData>;
	/** `sheets.update_cells`: the answer has each cell of the tab whose input or result changed. */
	update(cells: CellChange[], baseRevision: number, tabId: string): Promise<SheetData>;
	/** `sheets.add_tab`, `sheets.rename_tab`, `sheets.move_tab`, `sheets.duplicate_tab` or `sheets.delete_tab`. */
	changeTab(action: TabAction): Promise<TabsData>;
}

export interface SheetSnapshot {
	status: "loading" | "ready" | "error";
	/** The error of the first load. */
	loadError: unknown;
	item: DriveItem | null;
	/** The revision of the cells of the active tab. */
	revision: number;
	tabs: readonly Tab[];
	/** The id of the tab that the grid shows. */
	activeTab: string;
	/** True while the cells of the active tab did not arrive, or are older than a rename of a tab. */
	tabLoading: boolean;
	/** The cells of the active tab for the grid, with the changes that wait on top. */
	cells: ReadonlyMap<string, ViewCell>;
	saveState: SaveState;
	/** The error of the last save, while `saveState` is `error` or `conflict`. */
	saveError: unknown;
}

function isConflict(error: unknown): boolean {
	return error instanceof ApiError && error.code === "conflict";
}

function isNotFound(error: unknown): boolean {
	return error instanceof ApiError && error.code === "not_found";
}

/** The cells of a tab from the server, and the revision of the sheet that they are complete for. */
interface TabCells {
	revision: number;
	cells: Map<string, Cell>;
}

const NO_CHANGES: ReadonlyMap<string, string> = new Map();

export class SheetStore {
	private readonly api: SheetApi;
	private readonly listeners = new Set<() => void>();
	private status: SheetSnapshot["status"] = "loading";
	private loadError: unknown = null;
	private item: DriveItem | null = null;
	private tabs: Tab[] = [];
	/** The revision of the sheet that `tabs` comes from. An older answer does not change the tabs. */
	private tabsRevision = -1;
	private active = "";
	/**
	 * The cells of each tab that the page read. A write names the revision of the cells of its tab, so
	 * the server refuses it when the tab is not complete. The store then gets the tab again.
	 */
	private server = new Map<string, TabCells>();
	/**
	 * The tabs whose cells are older than a rename, with the revision of the rename. A rename changes
	 * the formulas of each tab that refers to the old name, so these cells show the old name. The grid
	 * shows them without edits until a read of the tab at that revision or later.
	 */
	private staleUntil = new Map<string, number>();
	/** The changes that no request has yet, by tab. */
	private waiting = new Map<string, Map<string, string>>();
	/** The changes of the request that is in progress. */
	private sending: { tab: string; cells: Map<string, string> } | null = null;
	private saveState: SaveState = "saved";
	private saveError: unknown = null;
	/** The save or the change of the tabs that is in progress. One runs at a time. */
	private running: Promise<void> | null = null;
	/** Grows with each local change. An answer to a refresh that started before the change is dropped. */
	private epoch = 0;
	/** The cells for the grid. Null after a change to the cells: the next snapshot makes them again. */
	private view: Map<string, ViewCell> | null = null;
	private snapshot: SheetSnapshot;

	constructor(api: SheetApi) {
		this.api = api;
		this.snapshot = this.makeSnapshot();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getSnapshot = (): SheetSnapshot => this.snapshot;

	/** Gets the first tab of the sheet for the first time, or again after the first load failed. */
	async load(): Promise<void> {
		this.status = "loading";
		this.loadError = null;
		this.emit();
		try {
			const data = await this.api.get();
			this.active = data.tab_id;
			this.take(data, null);
			this.status = "ready";
		} catch (error) {
			this.status = "error";
			this.loadError = error;
		}
		this.emit();
	}

	/** The input of a cell as the grid shows it. Empty for a cell without an input. */
	inputOf(cell: string, tab: string = this.active): string {
		const sending = this.sending?.tab === tab ? this.sending.cells : NO_CHANGES;
		return this.waiting.get(tab)?.get(cell) ?? sending.get(cell) ?? this.server.get(tab)?.cells.get(cell)?.input ?? "";
	}

	/**
	 * Changes cells of a tab. The grid shows the new inputs at once, and the store sends them to the
	 * server. A change that gives a cell the input that it has is dropped. A viewer cannot change cells.
	 * Nobody can change a tab whose cells did not arrive, because the old inputs are not known.
	 */
	commit(changes: readonly CellChange[], tab: string = this.active): void {
		const known = this.server.has(tab) && !this.staleUntil.has(tab);
		if (!this.canEdit() || !this.tabs.some((entry) => entry.id === tab) || !known) return;
		let changed = false;
		for (const { cell, input } of changes) {
			if (this.inputOf(cell, tab) === input) continue;
			let list = this.waiting.get(tab);
			if (!list) {
				list = new Map();
				this.waiting.set(tab, list);
			}
			list.set(cell, input);
			changed = true;
		}
		if (!changed) return;
		this.view = null;
		this.epoch++;
		if (!this.running) this.saveState = "unsaved";
		this.emit();
		void this.flush();
	}

	/** Shows a different tab. The grid shows the cells that the page has, and the store gets the tab again. */
	selectTab(tab: string): void {
		if (tab === this.active || !this.tabs.some((entry) => entry.id === tab)) return;
		this.active = tab;
		this.view = null;
		this.emit();
		void this.loadTab(tab);
	}

	/**
	 * Adds, renames, moves, copies or deletes a tab. The changes of cells that wait go to the server
	 * first. When they do not save, the change of the tabs stops, so a copy cannot miss them. Only the
	 * delete of the tab that has them continues. The grid then shows the new tab of an add or a copy.
	 * The active tab is read again, because a change to the tabs can change its formulas. Throws the
	 * error of the server.
	 */
	async changeTab(action: TabAction): Promise<void> {
		if (!this.canEdit()) return;
		try {
			await this.exclusive(async () => {
				const saved = await this.sendWaiting();
				const onlyDeleted = [...this.waiting.keys()].every((tab) => action.kind === "delete" && tab === action.tabId);
				if (!saved && !onlyDeleted) {
					throw new Error("Your last changes are not saved. Try again or discard them, then change the tabs.");
				}
				const answer = await this.api.changeTab(action);
				this.item = answer.item;
				this.setTabs(answer.tabs, answer.revision);
				if (answer.tab_id) this.active = answer.tab_id;
				if (action.kind === "rename") for (const id of this.server.keys()) this.staleUntil.set(id, answer.revision);
				this.prune();
				// The page sees the new tabs at once, also when the next read fails.
				this.emit();
				this.take(await this.fetchTab(this.active), null);
				this.emit();
			});
		} finally {
			// Changes that came during the change of the tabs go now. After a failed save, Try again sends them.
			const failed = this.saveState === "error" || this.saveState === "conflict";
			if (this.pending() > 0 && !failed) void this.flush();
		}
	}

	/** Sends the changes again after a save failed. */
	retry(): void {
		void this.flush();
	}

	/** Drops the changes that the server does not have, and gets the active tab again. */
	async discard(): Promise<void> {
		if (this.running) return;
		const epoch = ++this.epoch;
		const data = await this.fetchTab(this.active);
		if (epoch !== this.epoch || this.running) return;
		this.waiting.clear();
		this.server.delete(data.tab_id);
		this.take(data, null);
		this.saveState = "saved";
		this.saveError = null;
		this.emit();
	}

	/**
	 * Gets the active tab again, to show the changes of other people. It does nothing while a change
	 * waits, and it drops an answer that arrives after a new change.
	 */
	async refresh(): Promise<void> {
		if (this.status !== "ready" || this.running || this.pending() > 0) return;
		const epoch = this.epoch;
		let data: SheetData;
		try {
			data = await this.fetchTab(this.active);
		} catch {
			// The next refresh tries again.
			return;
		}
		if (epoch !== this.epoch || this.running || this.pending() > 0) return;
		this.take(data, epoch);
		this.emit();
	}

	/** Keeps the item after a rename or a star change in the header. */
	setItem(item: DriveItem): void {
		this.epoch++;
		this.item = item;
		this.emit();
	}

	/** True while a change is not on the server. */
	hasUnsaved(): boolean {
		return this.running !== null || this.pending() > 0;
	}

	private canEdit(): boolean {
		return this.status === "ready" && this.item?.role !== "viewer" && !this.item?.trashed;
	}

	/** The count of the changes that no request has yet. */
	private pending(): number {
		let count = 0;
		for (const list of this.waiting.values()) count += list.size;
		return count;
	}

	/** Runs one save or one change of the tabs at a time, so each request names the newest revision. */
	private async exclusive(task: () => Promise<void>): Promise<void> {
		while (this.running) await this.running;
		let release = () => {};
		this.running = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			await task();
		} finally {
			this.running = null;
			release();
		}
	}

	/** Gets a tab. When somebody deleted the tab, it gets the first tab. */
	private async fetchTab(tab: string): Promise<SheetData> {
		try {
			return await this.api.get(tab);
		} catch (error) {
			if (isNotFound(error)) return this.api.get();
			throw error;
		}
	}

	private async loadTab(tab: string): Promise<void> {
		const epoch = this.epoch;
		try {
			this.take(await this.fetchTab(tab), epoch);
		} catch {
			// The refresh tries again while the tab is active.
			return;
		}
		this.emit();
	}

	private setTabs(tabs: Tab[], revision: number): void {
		if (revision < this.tabsRevision) return;
		this.tabs = tabs;
		this.tabsRevision = revision;
	}

	/**
	 * Keeps a tab from the server. The cells replace the cells of the tab only when they are newer.
	 * With `epoch`, the item changes only when no local change came after that epoch.
	 */
	private take(data: SheetData, epoch: number | null): void {
		if (epoch === null || epoch === this.epoch) this.item = data.item;
		this.setTabs(data.tabs, data.revision);
		const cached = this.server.get(data.tab_id);
		if (!cached || data.revision > cached.revision) {
			this.server.set(data.tab_id, { revision: data.revision, cells: toCellMap(data.cells) });
			if (data.tab_id === this.active) this.view = null;
		}
		const until = this.staleUntil.get(data.tab_id);
		if (until !== undefined && data.revision >= until) this.staleUntil.delete(data.tab_id);
		this.prune();
	}

	/** Drops the cells and the changes of tabs that do not exist now. Without its tab, the grid shows the first tab. */
	private prune(): void {
		const ids = new Set(this.tabs.map((tab) => tab.id));
		for (const id of [...this.server.keys(), ...this.waiting.keys()]) {
			if (ids.has(id)) continue;
			this.server.delete(id);
			this.waiting.delete(id);
			this.staleUntil.delete(id);
		}
		if (!ids.has(this.active) && this.tabs[0]) {
			this.active = this.tabs[0].id;
			this.view = null;
		}
	}

	/** Sends the waiting changes, one request at a time. Changes that arrive during a request go into the next one. */
	private async flush(): Promise<void> {
		if (this.running || this.status !== "ready") return;
		await this.exclusive(async () => {
			await this.sendWaiting();
		});
	}

	/** The next changes of one tab to send. One call takes at most cellsPerUpdate cells, so a large paste goes in parts. */
	private nextBatch(): { tab: string; cells: Map<string, string> } | null {
		for (const [tab, list] of this.waiting) {
			const cells = new Map([...list].slice(0, SHEET_LIMITS.cellsPerUpdate));
			for (const cell of cells.keys()) list.delete(cell);
			if (list.size === 0) this.waiting.delete(tab);
			if (cells.size > 0) return { tab, cells };
		}
		return null;
	}

	/** Sends each waiting change. Returns false when a save failed: the changes then wait again. */
	private async sendWaiting(): Promise<boolean> {
		for (let batch = this.nextBatch(); batch; batch = this.nextBatch()) {
			this.sending = batch;
			this.view = null;
			this.saveState = "saving";
			this.saveError = null;
			this.emit();
			try {
				await this.send(batch.tab, batch.cells);
			} catch (error) {
				if (isNotFound(error)) await this.readTabs();
				// The changes wait again, while their tab exists. A newer change to the same cell stays.
				if (this.tabs.some((tab) => tab.id === batch.tab)) {
					this.waiting.set(batch.tab, new Map([...batch.cells, ...(this.waiting.get(batch.tab) ?? [])]));
				}
				this.sending = null;
				this.view = null;
				this.saveState = isConflict(error) ? "conflict" : "error";
				this.saveError = error;
				this.emit();
				return false;
			}
			this.sending = null;
			this.view = null;
		}
		this.saveState = "saved";
		this.emit();
		return true;
	}

	/** Gets the tabs again after a save to a tab that does not exist now. */
	private async readTabs(): Promise<void> {
		try {
			this.take(await this.api.get(), null);
		} catch {
			// The sheet itself is gone, or the network is. The error of the save says so.
		}
	}

	private async send(tab: string, batch: ReadonlyMap<string, string>): Promise<void> {
		const cells = [...batch].map(([cell, input]) => ({ cell, input }));
		let answer: SheetData;
		try {
			answer = await this.api.update(cells, this.server.get(tab)?.revision ?? 0, tab);
		} catch (error) {
			if (!isConflict(error)) throw error;
			// Somebody changed the sheet after this page read the tab. Get the tab again, then send the
			// same changes one more time on top of it.
			this.take(await this.api.get(tab), null);
			this.emit();
			answer = await this.api.update(cells, this.server.get(tab)?.revision ?? 0, tab);
		}
		this.item = answer.item;
		this.setTabs(answer.tabs, answer.revision);
		// The answer has the changed cells only. They complete the cells of the revision that the write
		// named. A tab that a newer read replaced keeps the newer cells.
		const cached = this.server.get(tab);
		if (cached && cached.revision < answer.revision) {
			applyCells(cached.cells, answer.cells);
			cached.revision = answer.revision;
		}
		if (tab === this.active) this.view = null;
	}

	private makeSnapshot(): SheetSnapshot {
		const cached = this.server.get(this.active);
		this.view ??= viewCells(
			cached?.cells ?? new Map(),
			this.sending?.tab === this.active ? this.sending.cells : NO_CHANGES,
			this.waiting.get(this.active) ?? NO_CHANGES,
		);
		return {
			status: this.status,
			loadError: this.loadError,
			item: this.item,
			revision: cached?.revision ?? 0,
			tabs: this.tabs,
			activeTab: this.active,
			tabLoading: this.status === "ready" && (!cached || this.staleUntil.has(this.active)),
			cells: this.view,
			saveState: this.saveState,
			saveError: this.saveError,
		};
	}

	private emit(): void {
		this.snapshot = this.makeSnapshot();
		for (const listener of this.listeners) listener();
	}
}
