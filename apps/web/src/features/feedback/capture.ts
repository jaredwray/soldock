import { FEEDBACK_LIMITS } from "@asterra/contracts";
import { pickRecorderType, RECORDING_MAX_BYTES, scaledSize } from "./model.ts";

// Screen capture with the browser APIs: a screenshot (one frame of `getDisplayMedia`) and a screen recording
// (`MediaRecorder`). The browser asks the person which screen, window or tab to share. No audio is captured.

/** The options of `getDisplayMedia`. `preferCurrentTab` is a Chromium option: it offers this tab first. */
const DISPLAY_OPTIONS = { video: true, audio: false, preferCurrentTab: true } as DisplayMediaStreamOptions;

export function supportsCapture(): boolean {
	return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";
}

export function supportsRecording(): boolean {
	return supportsCapture() && typeof MediaRecorder !== "undefined" && pickRecorderType(isTypeSupported) !== null;
}

function isTypeSupported(type: string): boolean {
	return MediaRecorder.isTypeSupported(type);
}

/** True when the person closed the picker of the browser or did not allow the capture. That is not an error. */
export function isCancelled(error: unknown): boolean {
	return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
}

function stopStream(stream: MediaStream): void {
	for (const track of stream.getTracks()) track.stop();
}

/** Asks the person what to share. Call it in the handler of a click: the browser needs a user gesture. */
export async function requestScreen(): Promise<MediaStream> {
	return await navigator.mediaDevices.getDisplayMedia(DISPLAY_OPTIONS);
}

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * One frame of the shared screen as a PNG image, or a JPEG image when the PNG is over the limit. `beforeFrame`
 * runs after the person chose what to share and before the frame: the dialog closes there, so it is not in the
 * screenshot. The function stops the stream.
 */
export async function captureFrame(stream: MediaStream, beforeFrame: () => void): Promise<Blob> {
	try {
		beforeFrame();
		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.srcObject = stream;
		await video.play();
		// The page needs a moment to paint without the dialog before the frame.
		await wait(400);
		const size = scaledSize(video.videoWidth, video.videoHeight);
		const canvas = document.createElement("canvas");
		canvas.width = size.width;
		canvas.height = size.height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("The browser cannot make a screenshot.");
		context.drawImage(video, 0, 0, size.width, size.height);
		video.srcObject = null;
		const png = await toBlob(canvas, "image/png");
		if (png && png.size <= FEEDBACK_LIMITS.attachmentBytes) return png;
		const jpeg = await toBlob(canvas, "image/jpeg", 0.85);
		if (!jpeg) throw new Error("The browser cannot make a screenshot.");
		return jpeg;
	} finally {
		stopStream(stream);
	}
}

export interface Recording {
	/** Stops the recording. `done` then gets the video. */
	stop(): void;
	/** The video when the recording stops: after `stop`, at the time limit, at the size limit, or when sharing ends. */
	done: Promise<Blob>;
}

/** Starts to record the shared screen. The recording stops at the time limit and before the size limit. */
export function startRecording(stream: MediaStream): Recording {
	const mimeType = pickRecorderType(isTypeSupported);
	if (!mimeType) {
		stopStream(stream);
		throw new Error("The browser cannot record the screen.");
	}
	const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_000_000 });
	const chunks: Blob[] = [];
	let size = 0;
	const stop = () => {
		if (recorder.state !== "inactive") recorder.stop();
	};
	const done = new Promise<Blob>((resolve, reject) => {
		recorder.addEventListener("dataavailable", (event) => {
			if (event.data.size === 0) return;
			chunks.push(event.data);
			size += event.data.size;
			if (size >= RECORDING_MAX_BYTES) stop();
		});
		recorder.addEventListener("stop", () => {
			window.clearTimeout(timer);
			stopStream(stream);
			if (size === 0) reject(new Error("The recording is empty."));
			else resolve(new Blob(chunks, { type: mimeType.split(";")[0] ?? mimeType }));
		});
		recorder.addEventListener("error", () => {
			window.clearTimeout(timer);
			stopStream(stream);
			reject(new Error("The recording failed."));
		});
	});
	// The "Stop sharing" button of the browser ends the track.
	for (const track of stream.getVideoTracks()) track.addEventListener("ended", stop);
	const timer = window.setTimeout(stop, FEEDBACK_LIMITS.recordingSeconds * 1000);
	recorder.start(1000);
	return { stop, done };
}
