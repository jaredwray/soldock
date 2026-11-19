import { DRIVE_LIMITS } from "@asterra/contracts";

// The small picture of a picture or a video file (`drive.set_preview`). The browser makes it, because a
// Worker cannot decode a picture or a video. Each failure gives null: the file works without a preview.

/** The longest time that the browser can take to make one preview. */
const PREVIEW_MS = 15_000;

/** The second of a video that the preview shows, at most. A short video shows its middle. */
const VIDEO_FRAME_S = 1;

/**
 * The size of the preview of a picture of `width` × `height` pixels: at most `side` pixels on each side,
 * and never larger than the picture. The height comes from the width, with the rule of the server
 * (`sameShape` in `apps/dock/src/drive/preview.ts`), so the server accepts the shape. Null when no
 * size fits, for example a picture that is more than `side` times as high as it is wide.
 */
export function previewSize(
	width: number,
	height: number,
	side: number = DRIVE_LIMITS.previewSide,
): { width: number; height: number } | null {
	if (!(width > 0 && height > 0)) return null;
	const scale = Math.min(1, side / width, side / height);
	let w = Math.max(1, Math.round(width * scale));
	let h = Math.max(1, Math.round((height * w) / width));
	while (h > side && w > 1) {
		w -= 1;
		h = Math.max(1, Math.round((height * w) / width));
	}
	return h > side ? null : { width: w, height: h };
}

/** True for a file that can get a preview: a picture or a video, from the type that the browser gives. */
export function wantsPreview(type: string): boolean {
	return /^(image|video)\//i.test(type);
}

/** Rejects after `ms`, so a picture or a video that does not decode cannot stop an upload. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("The preview took too long.")), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function once(target: EventTarget, success: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const done = () => {
			target.removeEventListener(success, done);
			target.removeEventListener("error", fail);
			resolve();
		};
		const fail = () => {
			target.removeEventListener(success, done);
			target.removeEventListener("error", fail);
			reject(new Error("The file did not decode."));
		};
		target.addEventListener(success, done);
		target.addEventListener("error", fail);
	});
}

/** Draws a source of `width` × `height` pixels on a canvas of the preview size. */
function draw(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement | null {
	const size = previewSize(width, height);
	if (!size) return null;
	const canvas = document.createElement("canvas");
	canvas.width = size.width;
	canvas.height = size.height;
	const context = canvas.getContext("2d");
	if (!context) return null;
	context.imageSmoothingQuality = "high";
	context.drawImage(source, 0, 0, size.width, size.height);
	return canvas;
}

/** The canvas on white. A JPEG file has no transparent pixels, which would show as black. */
function onWhite(canvas: HTMLCanvasElement): HTMLCanvasElement {
	const flat = document.createElement("canvas");
	flat.width = canvas.width;
	flat.height = canvas.height;
	const context = flat.getContext("2d");
	if (!context) return canvas;
	context.fillStyle = "#ffffff";
	context.fillRect(0, 0, flat.width, flat.height);
	context.drawImage(canvas, 0, 0);
	return flat;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * The bytes of the preview: WebP, or JPEG when the browser cannot write WebP (Safari writes PNG in its
 * place). Null when no form is small enough.
 */
async function encode(canvas: HTMLCanvasElement): Promise<Blob | null> {
	const webp = await toBlob(canvas, "image/webp", 0.8);
	if (webp?.type === "image/webp" && webp.size <= DRIVE_LIMITS.previewBytes) return webp;
	const flat = onWhite(canvas);
	for (const quality of [0.8, 0.6]) {
		const jpeg = await toBlob(flat, "image/jpeg", quality);
		if (jpeg?.type === "image/jpeg" && jpeg.size <= DRIVE_LIMITS.previewBytes) return jpeg;
	}
	return null;
}

async function pictureCanvas(file: Blob): Promise<HTMLCanvasElement | null> {
	// The bitmap follows the EXIF orientation of a JPEG file, as the server does when it checks the shape.
	const bitmap = await createImageBitmap(file);
	try {
		return draw(bitmap, bitmap.width, bitmap.height);
	} finally {
		bitmap.close();
	}
}

async function videoCanvas(file: Blob): Promise<HTMLCanvasElement | null> {
	const url = URL.createObjectURL(file);
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.preload = "auto";
	try {
		const loaded = once(video, "loadeddata");
		video.src = url;
		await loaded;
		const duration = Number.isFinite(video.duration) ? video.duration : 0;
		const at = Math.min(VIDEO_FRAME_S, duration / 2);
		if (at > 0) {
			const seeked = once(video, "seeked");
			video.currentTime = at;
			await seeked;
		}
		return draw(video, video.videoWidth, video.videoHeight);
	} finally {
		video.removeAttribute("src");
		video.load();
		URL.revokeObjectURL(url);
	}
}

/**
 * The preview of a picture or a video file, or null. It is a WebP or JPEG picture of at most 640 pixels
 * on each side and 256 KiB. A picture keeps its shape. A video shows a frame near its start.
 */
export async function makePreview(file: Blob): Promise<Blob | null> {
	try {
		const type = file.type.toLowerCase();
		const making = type.startsWith("video/") ? videoCanvas(file) : pictureCanvas(file);
		const canvas = await withTimeout(making, PREVIEW_MS);
		return canvas ? await encode(canvas) : null;
	} catch {
		return null;
	}
}
