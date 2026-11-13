import { ApiError, type Cell, type DriveItem, SHEET_LIMITS } from "@soldock/contracts";
import type { SaveState } from "../drive/DocumentHeader.tsx";
import { applyCells, type CellChange, toCellMap, type ViewCell, viewCells } from "./cells.ts";

// The state of one open sheet: the cells from the server, the changes that wait for the server, and
// the save queue. The store has no DOM use. The page gives it the two calls that it needs.

/** A sheet as `sheets.get` and `sheets.update_cells` return it. */
export interface SheetData {
	item: DriveItem;
	revision: number;
	cells: Cell[];
}

export interface SheetApi {
	/** `sheets.get`: each cell of the sheet. */
	get(): Promise<SheetData>;
	/** `sheets.update_cells`: the answer has each cell whose input or result changed. */
	update(cells: CellChange[], baseRevision: number): Promise<SheetData>;
}

export interface SheetSnapshot {
	status: "loading" | "ready" | "error";
	/** The error of the first load. */
	loadError: unknown;
	item: DriveItem | null;
	revision: number;
	/** The cells for the grid, with the changes that wait on top. */
	cells: ReadonlyMap<string, ViewCell>;
	saveState: SaveState;
	/** The error of the last save, while `saveState` is `error` or `conflict`. */
	saveError: unknown;
}

function isConflict(error: unknown): boolean {
	return error instanceof ApiError && error.code === "conflict";
}

export class SheetStore {
	private readonly api: SheetApi;
	private readonly listeners = new Set<() => void>();
	private status: SheetSnapshot["status"] = "loading";
	private loadError: unknown = null;
	private item: DriveItem | null = null;
	private revision = 0;
	private server = new Map<string, Cell>();
	/** The changes that no request has yet. */
	private waiting = new Map<string, string>();
	/** The changes of the request that is in progress. */
	private sending = new Map<string, string>();
	private saveState: SaveState = "saved";
	private saveError: unknown = null;
	private saving = false;
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

	/** Gets the sheet for the first time, or again after the first load failed. */
	async load(): Promise<void> {
		this.status = "loading";
		this.loadError = null;
		this.emit();
		try {
			this.replace(await this.api.get());
			this.status = "ready";
		} catch (error) {
			this.status = "error";
			this.loadError = error;
		}
		this.emit();
	}

	/** The input of a cell as the grid shows it. Empty for a cell without an input. */
	inputOf(cell: string): string {
		return this.waiting.get(cell) ?? this.sending.get(cell) ?? this.server.get(cell)?.input ?? "";
	}

	/**
	 * Changes cells. The grid shows the new inputs at once, and the store sends them to the server. A
	 * change that gives a cell the input that it has is dropped. A viewer cannot change cells.
	 */
	commit(changes: readonly CellChange[]): void {
		if (this.status !== "ready" || this.item?.role === "viewer") return;
		let changed = false;
		for (const { cell, input } of changes) {
			if (this.inputOf(cell) === input) continue;
			this.waiting.set(cell, input);
			changed = true;
		}
		if (!changed) return;
		this.view = null;
		this.epoch++;
		if (!this.saving) this.saveState = "unsaved";
		this.emit();
		void this.flush();
	}

	/** Sends the changes again after a save failed. */
	retry(): void {
		void this.flush();
	}

	/** Drops the changes that the server does not have, and gets the sheet again. */
	async discard(): Promise<void> {
		if (this.saving) return;
		const epoch = ++this.epoch;
		const data = await this.api.get();
		if (epoch !== this.epoch || this.saving) return;
		this.waiting.clear();
		this.view = null;
		this.replace(data);
		this.saveState = "saved";
		this.saveError = null;
		this.emit();
	}

	/**
	 * Gets the sheet again, to show the changes of other people. It does nothing while a change waits,
	 * and it drops an answer that arrives after a new change.
	 */
	async refresh(): Promise<void> {
		if (this.status !== "ready" || this.saving || this.waiting.size > 0) return;
		const epoch = this.epoch;
		let data: SheetData;
		try {
			data = await this.api.get();
		} catch {
			// The next refresh tries again.
			return;
		}
		if (epoch !== this.epoch || this.saving || this.waiting.size > 0) return;
		if (data.revision === this.revision) this.item = data.item;
		else this.replace(data);
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
		return this.saving || this.waiting.size > 0;
	}

	private replace(data: SheetData): void {
		this.item = data.item;
		this.revision = data.revision;
		this.server = toCellMap(data.cells);
		this.view = null;
	}

	/** Sends the waiting changes, one request at a time. Changes that arrive during a request go into the next one. */
	private async flush(): Promise<void> {
		if (this.saving || this.status !== "ready") return;
		this.saving = true;
		try {
			while (this.waiting.size > 0) {
				// One call takes at most cellsPerUpdate cells, so a large paste goes in parts.
				const batch = new Map([...this.waiting].slice(0, SHEET_LIMITS.cellsPerUpdate));
				for (const cell of batch.keys()) this.waiting.delete(cell);
				this.sending = batch;
				this.view = null;
				this.saveState = "saving";
				this.saveError = null;
				this.emit();
				try {
					await this.send(batch);
				} catch (error) {
					// The changes wait again. A newer change to the same cell stays.
					this.waiting = new Map([...batch, ...this.waiting]);
					this.sending = new Map();
					this.view = null;
					this.saveState = isConflict(error) ? "conflict" : "error";
					this.saveError = error;
					this.emit();
					return;
				}
				this.sending = new Map();
				this.view = null;
			}
			this.saveState = "saved";
			this.emit();
		} finally {
			this.saving = false;
		}
	}

	private async send(batch: ReadonlyMap<string, string>): Promise<void> {
		const cells = [...batch].map(([cell, input]) => ({ cell, input }));
		let answer: SheetData;
		try {
			answer = await this.api.update(cells, this.revision);
		} catch (error) {
			if (!isConflict(error)) throw error;
			// Somebody changed the sheet after this page read it. Get the sheet again, then send the same
			// changes one more time on top of it.
			this.replace(await this.api.get());
			this.emit();
			answer = await this.api.update(cells, this.revision);
		}
		this.item = answer.item;
		this.revision = answer.revision;
		applyCells(this.server, answer.cells);
		this.view = null;
	}

	private makeSnapshot(): SheetSnapshot {
		this.view ??= viewCells(this.server, this.sending, this.waiting);
		return {
			status: this.status,
			loadError: this.loadError,
			item: this.item,
			revision: this.revision,
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
