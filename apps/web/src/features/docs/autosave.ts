import type { SaveState } from "../drive/DocumentHeader.tsx";

// The save logic of the Docs editor. It uses no DOM and no React, so the Node tests can run it.

export interface AutosaveOptions {
	/**
	 * Sends the current content to the server with the revision that the editor has. Returns the new
	 * revision. It reads the content when it is called, so a save always sends the newest text.
	 */
	save: (baseRevision: number) => Promise<number>;
	/** True for the error of a save that the server refused because somebody changed the doc. */
	isConflict: (error: unknown) => boolean;
	/** The message for a person, from the error of a failed save. */
	describe: (error: unknown) => string;
	/** Called with each new state. `error` is the message of a failed save, or null. */
	onState: (state: SaveState, error: string | null) => void;
	/** The time between the last change and the save. */
	delayMs?: number;
}

export const AUTOSAVE_DELAY_MS = 1500;

/**
 * Saves a document a short time after the last change, with one request at a time. A change during
 * a save causes a second save after the first one, with the revision that the first one returned.
 * After a conflict, it saves nothing more until `reset` gives it the revision of a new version.
 */
export class Autosaver {
	private readonly options: AutosaveOptions;
	private currentRevision = 0;
	/** The number of changes, and the number that the server has. They are different while changes are not saved. */
	private changes = 0;
	private savedChanges = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private saving: Promise<void> | null = null;
	/** Grows with each reset. The answer of a save from before a reset is dropped. */
	private generation = 0;
	private current: SaveState = "saved";
	private disposed = false;

	constructor(options: AutosaveOptions) {
		this.options = options;
	}

	get state(): SaveState {
		return this.current;
	}

	/** The revision of the last content that the server has from this editor, or that the editor loaded. */
	get revision(): number {
		return this.currentRevision;
	}

	/** True while the editor has changes that the server does not have. */
	get dirty(): boolean {
		return this.changes !== this.savedChanges;
	}

	/** True while new content from the server must not replace the content of the editor. */
	get busy(): boolean {
		return this.dirty || this.saving !== null || this.current === "conflict";
	}

	/** The person changed the document. */
	changed(): void {
		this.changes += 1;
		if (this.current === "conflict") return;
		if (this.saving === null) this.set("unsaved");
		this.schedule();
	}

	/** Saves now, if a change is not saved. The promise ends when no save is in progress. */
	flush(): Promise<void> {
		this.cancelTimer();
		return this.run();
	}

	/** The editor loaded a version from the server. The changes before it are gone. */
	reset(revision: number): void {
		this.cancelTimer();
		this.generation += 1;
		this.saving = null;
		this.currentRevision = revision;
		this.savedChanges = this.changes;
		this.set("saved");
	}

	/** Stops the timer and the state calls. A save that is in progress still ends. */
	dispose(): void {
		this.cancelTimer();
		this.disposed = true;
	}

	private set(state: SaveState, error: string | null = null): void {
		this.current = state;
		if (!this.disposed) this.options.onState(state, error);
	}

	private cancelTimer(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}

	private schedule(): void {
		this.cancelTimer();
		if (this.disposed) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.run();
		}, this.options.delayMs ?? AUTOSAVE_DELAY_MS);
	}

	private run(): Promise<void> {
		if (this.saving !== null) return this.saving.then(() => this.run());
		if (!this.dirty || this.current === "conflict") return Promise.resolve();
		const generation = this.generation;
		const upTo = this.changes;
		this.set("saving");
		const saving = this.options.save(this.currentRevision).then(
			(revision) => {
				if (generation !== this.generation) return;
				this.saving = null;
				this.currentRevision = revision;
				this.savedChanges = upTo;
				if (!this.dirty) this.set("saved");
				else {
					this.set("unsaved");
					this.schedule();
				}
			},
			(error: unknown) => {
				if (generation !== this.generation) return;
				this.saving = null;
				if (this.options.isConflict(error)) this.set("conflict");
				else this.set("error", this.options.describe(error));
			},
		);
		this.saving = saving;
		return saving;
	}
}
