import { type CallInfo, type CallState, type EndReason, MEET_LIMITS, type SelfState } from "@asterra/contracts";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
import { setPageTitle } from "../../lib/pageTitle.ts";
import { BrandMark } from "../../shell/BrandMark.tsx";
import { CallView } from "./CallView.tsx";
import { callApi, savedToken, saveToken } from "./callApi.ts";
import { canCall, type LocalMedia, openLocalMedia, stopMedia } from "./devices.ts";
import { type MeetingWatch, watchMeeting } from "./signaling.ts";
import "./meet.css";

// The page of a meeting link (`/meet/<code>`). It is outside the signed-in app: a guest from outside the
// organization opens it with no account. A member who is signed in in this browser joins with the name of the
// directory. The phases: the check of the link, the device check before the join, the lobby, the call, and the end.

type Phase =
	| { name: "loading" }
	| { name: "gone"; message: string }
	| { name: "prejoin"; info: CallInfo; resume: boolean }
	| { name: "lobby"; info: CallInfo; token: string }
	| { name: "call"; info: CallInfo; token: string }
	| { name: "over"; info: CallInfo | null; reason: EndReason | "unavailable" | null };

const OVER_TEXT: Record<EndReason | "unavailable", { title: string; text: string; rejoin: boolean }> = {
	denied: { title: "The host did not let you in", text: "You can ask again with the link.", rejoin: true },
	removed: { title: "The host removed you from the meeting", text: "You can ask to join again.", rejoin: true },
	left: { title: "You left the meeting", text: "", rejoin: true },
	absent: { title: "You were away too long", text: "Your connection was lost for some time.", rejoin: true },
	ended: { title: "The meeting ended", text: "The host ended the meeting for everyone.", rejoin: false },
	cancelled: { title: "The meeting was cancelled", text: "This link does not work now.", rejoin: false },
	credential: { title: "Your session ended", text: "Sign in again, then open the link.", rejoin: false },
	expired: { title: "Your place in the meeting expired", text: "Join again with the link.", rejoin: true },
	unavailable: {
		title: "Meet is not set up",
		text: "The operator of this server did not set up the media service.",
		rejoin: false,
	},
};

export function MeetRoomPage({ code }: { code: string }) {
	const [phase, setPhase] = useState<Phase>({ name: "loading" });
	const [media, setMedia] = useState<LocalMedia | null>(null);
	const [want, setWant] = useState({ audio: true, video: true });
	const mediaRef = useRef<LocalMedia | null>(null);

	useEffect(() => {
		mediaRef.current = media;
	}, [media]);
	// The camera and the microphone stop when the page closes.
	useEffect(() => () => stopMedia(mediaRef.current?.stream ?? null), []);

	const load = useCallback(async () => {
		setPhase({ name: "loading" });
		try {
			const info = await callApi.info(code);
			setPageTitle(`${info.title || "Meeting"} – Asterra Meet`);
			if (info.status !== "open") return setPhase({ name: "over", info, reason: info.status });
			if (info.media === "not_configured") return setPhase({ name: "over", info, reason: "unavailable" });
			const token = savedToken(code);
			let resume = false;
			if (token) {
				try {
					const state = await callApi.state(code, token);
					if (state.self.state === "waiting") return setPhase({ name: "lobby", info, token });
					resume = state.self.state === "admitted";
					if (!resume) saveToken(code, null);
				} catch {
					saveToken(code, null);
				}
			}
			setPhase({ name: "prejoin", info, resume });
		} catch (error) {
			const status = (error as { status?: number }).status;
			setPhase({
				name: "gone",
				message: status === 404 ? "This meeting link does not work. Ask the host for a new link." : errorMessage(error),
			});
		}
	}, [code]);

	useEffect(() => {
		void load();
	}, [load]);

	// The browser asks for the microphone and the camera when the device check shows, and in the lobby after a reload.
	const needsMedia = phase.name === "prejoin" || phase.name === "lobby";
	useEffect(() => {
		if (!needsMedia || mediaRef.current) return;
		let live = true;
		void openLocalMedia().then((opened) => {
			if (live) setMedia(opened);
			else stopMedia(opened.stream);
		});
		return () => {
			live = false;
		};
	}, [needsMedia]);

	const finish = useCallback(
		(info: CallInfo | null, reason: EndReason | null) => {
			if (reason !== "left" && reason !== "absent") saveToken(code, null);
			setPhase({ name: "over", info, reason });
		},
		[code],
	);

	async function rejoin(info: CallInfo | null) {
		saveToken(code, null);
		stopMedia(mediaRef.current?.stream ?? null);
		setMedia(null);
		if (info) setPhase({ name: "prejoin", info: { ...info }, resume: false });
		else await load();
	}

	switch (phase.name) {
		case "loading":
			return (
				<main className="meet-page meet-center">
					<p role="status">
						<span className="spinner" aria-hidden="true" /> Opening the meeting…
					</p>
				</main>
			);
		case "gone":
			return (
				<main className="meet-page meet-center">
					<div className="meet-card">
						<BrandMark />
						<h1 className="meet-title">The meeting did not open</h1>
						<p role="alert">{phase.message}</p>
					</div>
				</main>
			);
		case "prejoin":
			return (
				<PreJoin
					code={code}
					info={phase.info}
					resume={phase.resume}
					media={media}
					want={want}
					onWant={setWant}
					onJoined={(token, self) => {
						saveToken(code, token);
						if (self.state === "admitted") setPhase({ name: "call", info: phase.info, token });
						else setPhase({ name: "lobby", info: phase.info, token });
					}}
					onOver={(reason) => finish(phase.info, reason)}
				/>
			);
		case "lobby":
			return (
				<Lobby
					code={code}
					info={phase.info}
					token={phase.token}
					media={media}
					onAdmitted={() => setPhase({ name: "call", info: phase.info, token: phase.token })}
					onOver={(reason) => finish(phase.info, reason)}
				/>
			);
		case "call":
			return (
				<CallView
					code={code}
					info={phase.info}
					token={phase.token}
					local={media}
					startMuted={!want.audio}
					startWithoutVideo={!want.video}
					onLocal={setMedia}
					onOver={(reason) => {
						stopMedia(mediaRef.current?.stream ?? null);
						setMedia(null);
						finish(phase.info, reason);
					}}
				/>
			);
		case "over": {
			const text = phase.reason
				? OVER_TEXT[phase.reason]
				: { title: "You are not in the meeting", text: "", rejoin: true };
			return (
				<main className="meet-page meet-center">
					<div className="meet-card">
						<BrandMark />
						<h1 className="meet-title">{text.title}</h1>
						{text.text && <p>{text.text}</p>}
						{text.rejoin && phase.info?.status === "open" && (
							<button type="button" className="button button-primary" onClick={() => void rejoin(phase.info)}>
								Join again
							</button>
						)}
					</div>
				</main>
			);
		}
	}
}

function Preview({ media, video }: { media: LocalMedia | null; video: boolean }) {
	const ref = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		element.srcObject = media?.video && video ? new MediaStream([media.video]) : null;
	}, [media, video]);
	return (
		<div className="meet-preview">
			{media?.video && video ? (
				<video ref={ref} className="meet-video meet-mirror" autoPlay playsInline muted aria-label="Your camera" />
			) : (
				<div className="meet-preview-off">{media === null ? "Asking for your camera…" : "Camera is off"}</div>
			)}
		</div>
	);
}

/** A bar that moves with the level of the microphone, so a person sees that the browser hears them. */
function MicLevel({ track, on }: { track: MediaStreamTrack | null; on: boolean }) {
	const [level, setLevel] = useState(0);
	useEffect(() => {
		if (!track || !on || typeof AudioContext !== "function") {
			setLevel(0);
			return;
		}
		const context = new AudioContext();
		const source = context.createMediaStreamSource(new MediaStream([track]));
		const analyser = context.createAnalyser();
		analyser.fftSize = 256;
		source.connect(analyser);
		const data = new Uint8Array(analyser.frequencyBinCount);
		let frame = 0;
		const tick = () => {
			analyser.getByteTimeDomainData(data);
			let peak = 0;
			for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
			setLevel(Math.min(1, peak / 64));
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(frame);
			void context.close();
		};
	}, [track, on]);
	return (
		<meter className="meet-level" aria-label="Microphone level" min={0} max={100} value={Math.round(level * 100)} />
	);
}

interface PreJoinProps {
	code: string;
	info: CallInfo;
	resume: boolean;
	media: LocalMedia | null;
	want: { audio: boolean; video: boolean };
	onWant(want: { audio: boolean; video: boolean }): void;
	onJoined(token: string, self: SelfState): void;
	onOver(reason: EndReason | null): void;
}

function PreJoin({ code, info, resume, media, want, onWant, onJoined, onOver }: PreJoinProps) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nameId = useId();
	const member = info.viewer;

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!canCall()) return setError("This browser cannot make calls. Open the link in a current browser.");
		const saved = savedToken(code);
		if (resume && saved) return onJoined(saved, { state: "admitted" } as SelfState);
		const trimmed = name.trim();
		if (!member && trimmed === "") return setError("Enter your name.");
		setBusy(true);
		setError(null);
		try {
			const joined = await callApi.join(code, member ? null : trimmed);
			onJoined(joined.token, joined.participant);
		} catch (caught) {
			const status = (caught as { status?: number }).status;
			if (status === 409) return onOver(null);
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	const hasAudio = media?.audio !== null && media?.audio !== undefined;
	const hasVideo = media?.video !== null && media?.video !== undefined;
	const label = resume ? "Rejoin" : member?.is_host ? "Start the meeting" : member ? "Join now" : "Ask to join";

	return (
		<main className="meet-page meet-prejoin">
			<section className="meet-prejoin-media">
				<Preview media={media} video={want.video} />
				<div className="meet-controls">
					<button
						type="button"
						className={`meet-round${want.audio && hasAudio ? "" : " meet-round-off"}`}
						aria-pressed={!(want.audio && hasAudio)}
						disabled={!hasAudio}
						onClick={() => onWant({ ...want, audio: !want.audio })}
					>
						<Icon name={want.audio && hasAudio ? "microphone" : "microphoneOff"} />
						<span className="visually-hidden">
							{!hasAudio ? "No microphone" : want.audio ? "Turn off microphone" : "Turn on microphone"}
						</span>
					</button>
					<button
						type="button"
						className={`meet-round${want.video && hasVideo ? "" : " meet-round-off"}`}
						aria-pressed={!(want.video && hasVideo)}
						disabled={!hasVideo}
						onClick={() => onWant({ ...want, video: !want.video })}
					>
						<Icon name={want.video && hasVideo ? "video" : "videoOff"} />
						<span className="visually-hidden">
							{!hasVideo ? "No camera" : want.video ? "Turn off camera" : "Turn on camera"}
						</span>
					</button>
				</div>
				<MicLevel track={media?.audio ?? null} on={want.audio} />
				{media?.problem && (
					<p className="meet-notice" role="status">
						{media.problem}
					</p>
				)}
			</section>
			<section className="meet-prejoin-form">
				<BrandMark />
				<h1 className="meet-title">{info.title || "Meeting"}</h1>
				<p className="meet-muted">Host: {info.host_name}</p>
				<form onSubmit={submit} noValidate>
					{member ? (
						<p>
							You join as <strong>{member.display_name}</strong>.
						</p>
					) : resume ? null : (
						<div className="field">
							<label htmlFor={nameId} className="field-label">
								Your name
							</label>
							<input
								id={nameId}
								className="input"
								value={name}
								maxLength={MEET_LIMITS.displayNameChars}
								autoComplete="name"
								onChange={(event) => setName(event.target.value)}
								disabled={busy}
								aria-invalid={error ? true : undefined}
							/>
							<p className="field-hint">The host sees this name and decides if you can join.</p>
						</div>
					)}
					<div aria-live="assertive">
						{error && (
							<p className="form-error" role="alert">
								{error}
							</p>
						)}
					</div>
					<button type="submit" className="button button-primary button-block" disabled={busy || media === null}>
						{busy ? "Joining…" : label}
					</button>
					{!hasAudio && !hasVideo && media !== null && <p className="field-hint">You join to listen and watch.</p>}
				</form>
			</section>
		</main>
	);
}

interface LobbyProps {
	code: string;
	info: CallInfo;
	token: string;
	media: LocalMedia | null;
	onAdmitted(): void;
	onOver(reason: EndReason | null): void;
}

function Lobby({ code, info, token, media, onAdmitted, onOver }: LobbyProps) {
	const watch = useRef<MeetingWatch | null>(null);
	// The parent gives new callbacks on each render. The socket of the lobby must not open again for that.
	const callbacks = useRef({ onAdmitted, onOver });
	callbacks.current = { onAdmitted, onOver };
	useEffect(() => {
		let done = false;
		watch.current = watchMeeting(code, token, {
			state(state: CallState) {
				if (!done && state.self.state === "admitted") {
					done = true;
					watch.current?.stop();
					callbacks.current.onAdmitted();
				}
			},
			closed(reason) {
				if (!done) callbacks.current.onOver(reason);
			},
		});
		return () => {
			done = true;
			watch.current?.stop();
		};
	}, [code, token]);

	async function leave() {
		try {
			await callApi.leave(code, token);
		} finally {
			onOver("left");
		}
	}

	return (
		<main className="meet-page meet-prejoin">
			<section className="meet-prejoin-media">
				<Preview media={media} video />
			</section>
			<section className="meet-prejoin-form" aria-live="polite">
				<BrandMark />
				<h1 className="meet-title">{info.title || "Meeting"}</h1>
				<p className="meet-lobby" role="status">
					<span className="spinner" aria-hidden="true" /> Waiting for {info.host_name} to let you in…
				</p>
				<p className="meet-muted">You do not send or receive audio or video until the host lets you in.</p>
				<button type="button" className="button" onClick={() => void leave()}>
					Leave
				</button>
			</section>
		</main>
	);
}
