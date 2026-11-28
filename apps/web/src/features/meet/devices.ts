// The microphone and the camera of the browser. A person can refuse one or both, and a phone can have no camera.
// The join flow then continues with what the browser gives: audio and video, audio only, video only, or nothing,
// to listen and watch.

export interface LocalMedia {
	stream: MediaStream;
	audio: MediaStreamTrack | null;
	video: MediaStreamTrack | null;
	/** A text for the person when the browser did not give a device, or null. */
	problem: string | null;
}

const VIDEO: MediaTrackConstraints = { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: "user" };
const AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

function deviceName(error: unknown): string {
	return error instanceof DOMException ? error.name : "";
}

function refusalText(audioError: unknown, videoError: unknown, gotAudio: boolean, gotVideo: boolean): string | null {
	if (gotAudio && gotVideo) return null;
	const denied = [audioError, videoError].some((error) =>
		["NotAllowedError", "SecurityError", "PermissionDeniedError"].includes(deviceName(error)),
	);
	const missing = !gotAudio && !gotVideo;
	if (missing) {
		return denied
			? "The browser does not let this page use your microphone or camera. You can join to listen and watch. To talk, allow them in the settings of the site, then try again."
			: "No microphone or camera was found. You can join to listen and watch.";
	}
	if (!gotVideo) {
		return denied
			? "The browser does not let this page use your camera. You can join with audio only."
			: "No camera was found. You can join with audio only.";
	}
	return denied
		? "The browser does not let this page use your microphone. Others cannot hear you."
		: "No microphone was found. Others cannot hear you.";
}

/** True when this browser can make a call at all. */
export function canCall(): boolean {
	return typeof RTCPeerConnection === "function";
}

/** Asks for the microphone and the camera. Never throws: a refusal gives a text and fewer tracks. */
export async function openLocalMedia(
	want: { audio: boolean; video: boolean } = { audio: true, video: true },
): Promise<LocalMedia> {
	const stream = new MediaStream();
	const devices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
	if (!devices?.getUserMedia) {
		return {
			stream,
			audio: null,
			video: null,
			problem:
				"This browser does not give this page a microphone or a camera. Open the link in a current browser over https.",
		};
	}
	let audioError: unknown = null;
	let videoError: unknown = null;
	// One request for both shows one prompt. When it fails, ask for each device alone, so one refusal does not
	// stop the other device.
	if (want.audio && want.video) {
		try {
			const both = await devices.getUserMedia({ audio: AUDIO, video: VIDEO });
			for (const track of both.getTracks()) stream.addTrack(track);
		} catch (error) {
			audioError = error;
			videoError = error;
		}
	}
	if (want.audio && stream.getAudioTracks().length === 0) {
		try {
			const audio = await devices.getUserMedia({ audio: AUDIO });
			for (const track of audio.getAudioTracks()) stream.addTrack(track);
			audioError = null;
		} catch (error) {
			audioError = error;
		}
	}
	if (want.video && stream.getVideoTracks().length === 0) {
		try {
			const video = await devices.getUserMedia({ video: VIDEO });
			for (const track of video.getVideoTracks()) stream.addTrack(track);
			videoError = null;
		} catch (error) {
			videoError = error;
		}
	}
	const audio = stream.getAudioTracks()[0] ?? null;
	const video = stream.getVideoTracks()[0] ?? null;
	return {
		stream,
		audio,
		video,
		problem: refusalText(audioError, videoError, audio !== null || !want.audio, video !== null || !want.video),
	};
}

/** Opens the camera again after the person turned video off. Null when the browser refuses. */
export async function openCamera(): Promise<MediaStreamTrack | null> {
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO });
		return stream.getVideoTracks()[0] ?? null;
	} catch {
		return null;
	}
}

/** Stops each track of a stream, so the browser turns off the camera light. */
export function stopMedia(stream: MediaStream | null): void {
	for (const track of stream?.getTracks() ?? []) track.stop();
}
