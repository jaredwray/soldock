import { DOC_IMAGE_TYPES, DOC_LIMITS, type DocImage, type DocImageType } from "@soldock/contracts";
import { api, errorMessage } from "../../lib/api.ts";
import { base64ToBytes, bytesToBase64 } from "../../lib/base64.ts";

// The images of one open doc: what the doc holds, the bytes that the editor has, and the uploads that
// are in progress. The bytes of an image come from `docs.get_image` as base64 and go into the page as a
// `blob:` address of a raster type. An image never comes from an address outside this origin.

/** Where a new image comes from. */
export type ImageSource =
	/** A file from a drop, a paste or the file dialog. */
	| { kind: "file"; file: Blob; name: string | null }
	/** The address of a pasted image: a `data:` address, or an https address that the server downloads. */
	| { kind: "address"; src: string }
	/** An image file of Drive. */
	| { kind: "drive"; spaceId: string; itemId: string }
	/** An image of a different doc, from a paste. */
	| { kind: "doc"; spaceId: string | null; itemId: string; imageId: string };

/** One upload, copy or import. The image node of the editor has its key until the job ends. */
export interface ImageJob {
	/** `job:<random>`. The `pending` attribute of the node has this value. */
	key: string;
	status: "running" | "done" | "failed";
	/** A `blob:` address of the local file, to show the image before the upload ends. */
	preview: string | null;
	image: DocImage | null;
	error: string | null;
}

type Call = typeof api.call;

const IMAGE_TYPES: readonly string[] = DOC_IMAGE_TYPES;

/** The `accept` value of a file input for the images of a doc. */
export const DOC_IMAGE_ACCEPT = DOC_IMAGE_TYPES.join(",");

/** The requests for image bytes that run at the same time. A doc can have many images. */
const PARALLEL_LOADS = 4;

/**
 * The time that an image of this editor stays in the list when an answer of the server does not have
 * it. A read of the doc that started before the upload ended has no such image yet.
 */
const NEW_IMAGE_MS = 60_000;

function megabytes(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** The reason that a file cannot be an image of a doc, or null. The server checks the bytes again. */
export function fileProblem(file: Pick<Blob, "type" | "size">): string | null {
	if (!IMAGE_TYPES.includes(file.type)) return "Only PNG, JPEG, GIF and WebP images can go into a doc.";
	if (file.size > DOC_LIMITS.imageBytes) return `An image can be at most ${megabytes(DOC_LIMITS.imageBytes)}.`;
	return null;
}

/** The image of a `data:` address with base64, or null when the address is not such an image. */
export function dataUrlBlob(src: string): Blob | null {
	const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]*)$/i.exec(src);
	if (!match) return null;
	try {
		return new Blob([base64ToBytes((match[2] as string).replace(/\s+/g, ""))], {
			type: (match[1] as string).toLowerCase(),
		});
	} catch {
		return null;
	}
}

export class DocImages {
	private readonly doc: { spaceId: string; itemId: string };
	private readonly call: Call;
	private readonly metas = new Map<string, DocImage>();
	/** The time that this editor added an image, by id. */
	private readonly added = new Map<string, number>();
	private readonly urls = new Map<string, Promise<string>>();
	private readonly objectUrls = new Set<string>();
	private readonly jobs = new Map<string, ImageJob>();
	private readonly listeners = new Set<(job: ImageJob | null) => void>();
	private readonly waiting: (() => void)[] = [];
	private loading = 0;
	private disposed = false;

	constructor(doc: { spaceId: string; itemId: string }, call: Call = api.call) {
		this.doc = doc;
		this.call = call;
	}

	/** The drive and the item of the doc. A copy of an image writes them to the clipboard. */
	get target(): { spaceId: string; itemId: string } {
		return this.doc;
	}

	/** Sets the images that the server says the doc holds. An image that this editor added a moment ago stays. */
	setAll(images: readonly DocImage[], now = Date.now()): void {
		const next = new Map(images.map((image) => [image.id, image]));
		for (const [id, image] of this.metas) {
			const at = this.added.get(id);
			if (!next.has(id) && at !== undefined && now - at < NEW_IMAGE_MS) next.set(id, image);
		}
		this.metas.clear();
		for (const [id, image] of next) this.metas.set(id, image);
		for (const id of this.added.keys()) if (!this.metas.has(id)) this.added.delete(id);
		this.emit(null);
	}

	meta(id: string): DocImage | undefined {
		return this.metas.get(id);
	}

	/** True for an image that the doc holds. The content of a save has only such images. */
	holds = (id: string): boolean => this.metas.has(id);

	job(key: string): ImageJob | undefined {
		return this.jobs.get(key);
	}

	/** Calls `listener` when a job ends (with the job) and when the list of the images changes (with null). */
	subscribe(listener: (job: ImageJob | null) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(job: ImageJob | null): void {
		if (this.disposed) return;
		for (const listener of [...this.listeners]) listener(job);
	}

	private objectUrl(blob: Blob): string {
		const url = URL.createObjectURL(blob);
		this.objectUrls.add(url);
		return url;
	}

	/** Runs `task` when fewer than `PARALLEL_LOADS` requests run. */
	private queued<T>(task: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const run = () => {
				this.loading += 1;
				task()
					.then(resolve, reject)
					.finally(() => {
						this.loading -= 1;
						this.waiting.shift()?.();
					});
			};
			if (this.loading < PARALLEL_LOADS) run();
			else this.waiting.push(run);
		});
	}

	/**
	 * The `blob:` address of an image, for an `<img>`. The bytes are requested one time. After a failure,
	 * a later call requests them again.
	 */
	load(id: string): Promise<string> {
		const known = this.urls.get(id);
		if (known) return known;
		const request = this.queued(async () => {
			const result = await this.call("docs.get_image", {
				space_id: this.doc.spaceId,
				item_id: this.doc.itemId,
				image_id: id,
			});
			const type = result.image.mime_type;
			// The type is one of the raster types, or the bytes do not go into the page.
			if (!IMAGE_TYPES.includes(type)) throw new Error("The image has a type that a doc cannot show.");
			if (this.disposed) throw new Error("The doc is closed.");
			return this.objectUrl(new Blob([base64ToBytes(result.content_base64)], { type }));
		});
		this.urls.set(id, request);
		request.catch(() => {
			if (this.urls.get(id) === request) this.urls.delete(id);
		});
		return request;
	}

	private remember(image: DocImage, url: string | null): void {
		this.metas.set(image.id, image);
		this.added.set(image.id, Date.now());
		if (url !== null && !this.urls.has(image.id)) this.urls.set(image.id, Promise.resolve(url));
	}

	private async upload(job: ImageJob, file: Blob, name: string | null): Promise<DocImage> {
		const problem = fileProblem(file);
		if (problem) throw new Error(problem);
		// A local file shows at once, from its own bytes. Only a raster type gets an address.
		const preview = this.objectUrl(new Blob([file], { type: file.type as DocImageType }));
		job.preview = preview;
		this.emit(null);
		const result = await this.call("docs.upload_image", {
			space_id: this.doc.spaceId,
			item_id: this.doc.itemId,
			...(name ? { name: name.slice(0, 255) } : {}),
			content_base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
		});
		this.remember(result.image, preview);
		return result.image;
	}

	private async run(job: ImageJob, source: ImageSource): Promise<DocImage> {
		const target = { space_id: this.doc.spaceId, item_id: this.doc.itemId };
		switch (source.kind) {
			case "file":
				return this.upload(job, source.file, source.name);
			case "address": {
				if (source.src.startsWith("data:")) {
					const blob = dataUrlBlob(source.src);
					if (!blob) throw new Error("The pasted image is not a PNG, JPEG, GIF or WebP image.");
					return this.upload(job, blob, null);
				}
				const result = await this.call("docs.import_image", { ...target, url: source.src });
				this.remember(result.image, null);
				return result.image;
			}
			case "drive": {
				const result = await this.call("docs.copy_image", {
					...target,
					from_space_id: source.spaceId,
					from_item_id: source.itemId,
				});
				this.remember(result.image, null);
				return result.image;
			}
			case "doc": {
				const result = await this.call("docs.copy_image", {
					...target,
					...(source.spaceId ? { from_space_id: source.spaceId } : {}),
					from_item_id: source.itemId,
					from_image_id: source.imageId,
				});
				this.remember(result.image, null);
				return result.image;
			}
		}
	}

	/** Starts an upload, a copy or an import. The job ends later, and the listeners get it then. */
	start(source: ImageSource): ImageJob {
		const job: ImageJob = {
			key: `job:${crypto.randomUUID()}`,
			status: "running",
			preview: null,
			image: null,
			error: null,
		};
		this.jobs.set(job.key, job);
		this.run(job, source).then(
			(image) => {
				job.status = "done";
				job.image = image;
				this.emit(job);
			},
			(error: unknown) => {
				job.status = "failed";
				job.error = errorMessage(error);
				this.emit(job);
			},
		);
		return job;
	}

	/** Releases the `blob:` addresses. The page of the doc calls this when it closes. */
	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
		for (const url of this.objectUrls) URL.revokeObjectURL(url);
		this.objectUrls.clear();
	}
}
