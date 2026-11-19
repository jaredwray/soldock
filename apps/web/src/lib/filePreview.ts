import { DRIVE_LIMITS } from "@asterra/contracts";
import { createLimiter } from "./limiter.ts";

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

/**
 * The pictures that a browser can draw on a canvas. Most browsers cannot draw TIFF or HEIC, so the list has
 * no such type.
 */
const PICTURE_TYPES: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
]);
/** The videos that a browser can play. */
const VIDEO_TYPES: ReadonlySet<string> = new Set(["video/mp4", "video/webm"]);
/**
 * The largest picture that gets a preview. The browser decodes all of the picture, so a larger one could
 * use too much memory. A video decodes only its first frames, so it has no limit.
 */
const PICTURE_BYTES = 20 * 1024 * 1024;

/**
 * True for a file that can get a preview: a picture of a type that a browser can draw, of at most 20 MiB,
 * or a video of a type that a browser can play. The type is the type that the browser gave.
 */
export function wantsPreview(type: string, size: number): boolean {
	const base = type.toLowerCase().split(";")[0]?.trim() ?? "";
	if (!(size > 0)) return false;
	return VIDEO_TYPES.has(base) || (PICTURE_TYPES.has(base) && size <= PICTURE_BYTES);
}

/** Rejects when the signal aborts: the preview took too long. */
function untilAbort(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

/** Waits for the event `success` of an element. An error event, and the end of the time, reject. */
function once(target: EventTarget, success: string, signal: AbortSignal): Promise<void> {
	const done = new Promise<void>((resolve, reject) => {
		const end = () => {
			target.removeEventListener(success, ok);
			target.removeEventListener("error", fail);
		};
		const ok = () => {
			end();
			resolve();
		};
		const fail = () => {
			end();
			reject(new Error("The file did not decode."));
		};
		target.addEventListener(success, ok);
		target.addEventListener("error", fail);
	});
	return Promise.race([done, untilAbort(signal)]);
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

async function pictureCanvas(file: Blob, signal: AbortSignal): Promise<HTMLCanvasElement | null> {
	// The bitmap follows the EXIF orientation of a JPEG file, as the server does when it checks the shape.
	const decoding = createImageBitmap(file);
	// A bitmap that comes after the end of the time is closed at once.
	signal.addEventListener(
		"abort",
		() =>
			void decoding.then(
				(late) => late.close(),
				() => {},
			),
		{ once: true },
	);
	const bitmap = await Promise.race([decoding, untilAbort(signal)]);
	try {
		return draw(bitmap, bitmap.width, bitmap.height);
	} finally {
		bitmap.close();
	}
}

async function videoCanvas(file: Blob, signal: AbortSignal): Promise<HTMLCanvasElement | null> {
	const url = URL.createObjectURL(file);
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.preload = "auto";
	try {
		const loaded = once(video, "loadeddata", signal);
		video.src = url;
		await loaded;
		const duration = Number.isFinite(video.duration) ? video.duration : 0;
		const at = Math.min(VIDEO_FRAME_S, duration / 2);
		if (at > 0) {
			const seeked = once(video, "seeked", signal);
			video.currentTime = at;
			await seeked;
		}
		return draw(video, video.videoWidth, video.videoHeight);
	} finally {
		// Also at the end of the time: the element stops its load, and the address of the file goes.
		video.removeAttribute("src");
		video.load();
		URL.revokeObjectURL(url);
	}
}

/** One preview at a time, so ten pictures of a message do not decode at the same time. */
const previews = createLimiter(1);

/**
 * The preview of a picture or a video file, or null. It is a WebP or JPEG picture of at most 640 pixels
 * on each side and 256 KiB. A picture keeps its shape. A video shows a frame near its start. Call it only
 * for a file that `wantsPreview` accepts.
 */
export function makePreview(file: Blob): Promise<Blob | null> {
	return previews
		.run(async () => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(new Error("The preview took too long.")), PREVIEW_MS);
			try {
				const making = file.type.toLowerCase().startsWith("video/")
					? videoCanvas(file, controller.signal)
					: pictureCanvas(file, controller.signal);
				const canvas = await making;
				return canvas ? await encode(canvas) : null;
			} finally {
				clearTimeout(timer);
			}
		})
		.catch(() => null);
}
