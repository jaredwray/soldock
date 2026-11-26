import type { CallInfo, CallState, EndReason, LobbyEntry, RosterEntry } from "@asterra/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Icon } from "../../lib/icons.tsx";
import { useToast } from "../../lib/toast.tsx";
import { callApi } from "./callApi.ts";
import { type LocalMedia, openCamera } from "./devices.ts";
import { MediaSession, type MediaStatus } from "./mediaSession.ts";
import { type MeetingWatch, watchMeeting } from "./signaling.ts";

// The call: a tile for each participant, the controls of this participant, and for the host the lobby and the
// actions on each participant. The host actions are the operations of Meet, as for an agent.

interface CallViewProps {
	code: string;
	info: CallInfo;
	token: string;
	local: LocalMedia | null;
	startMuted: boolean;
	startWithoutVideo: boolean;
	onLocal(media: LocalMedia): void;
	onOver(reason: EndReason | null): void;
}

const STATUS_TEXT: Partial<Record<MediaStatus, string>> = {
	connecting: "Connecting…",
	reconnecting: "Connection lost. Connecting again…",
	failed: "The call could not connect.",
};

export function CallView({ code, info, token, local, startMuted, startWithoutVideo, onLocal, onOver }: CallViewProps) {
	const [state, setState] = useState<CallState | null>(null);
	const [remote, setRemote] = useState<ReadonlyMap<string, MediaStreamTrack>>(new Map());
	const [status, setStatus] = useState<MediaStatus>("connecting");
	const [muted, setMuted] = useState(startMuted || !local?.audio);
	const [videoOn, setVideoOn] = useState(!startWithoutVideo && Boolean(local?.video));
	const [soundBlocked, setSoundBlocked] = useState(false);
	const [confirmEnd, setConfirmEnd] = useState(false);
	const [busy, setBusy] = useState(false);
	const session = useRef<MediaSession | null>(null);
	const watch = useRef<MeetingWatch | null>(null);
	const localRef = useRef(local);
	const overRef = useRef(onOver);
	overRef.current = onOver;
	const toast = useToast();
	const blockSound = useCallback(() => setSoundBlocked(true), []);

	useEffect(() => {
		const media = new MediaSession(code, token, {
			status: setStatus,
			track(trackId, track) {
				setRemote((previous) => new Map(previous).set(trackId, track));
			},
			removed(trackId) {
				setRemote((previous) => {
					const next = new Map(previous);
					next.delete(trackId);
					return next;
				});
			},
		});
		session.current = media;
		const start = localRef.current;
		if (start?.audio && startMuted) start.audio.enabled = false;
		if (start?.video && startWithoutVideo) {
			start.video.stop();
			start.stream.removeTrack(start.video);
		}
		void media
			.start({ audio: start?.audio ?? null, video: startWithoutVideo ? null : (start?.video ?? null) })
			.then(() => (start?.audio && startMuted ? media.setMuted(true) : undefined))
			.catch((error: unknown) => {
				const status = (error as { status?: number }).status;
				if (status === 403 || status === 401) watch.current?.refresh();
				else media.restart();
			});
		watch.current = watchMeeting(code, token, {
			state(next) {
				setState(next);
				if (next.self.state === "admitted" && next.participants) media.follow(next.participants, next.self.id);
			},
			closed(reason) {
				media.close();
				overRef.current(reason);
			},
		});
		return () => {
			watch.current?.stop();
			media.close();
		};
	}, [code, token, startMuted, startWithoutVideo]);

	async function toggleMute() {
		const next = !muted;
		setMuted(next);
		try {
			await session.current?.setMuted(next);
		} catch (error) {
			toast({ message: errorMessage(error), tone: "error" });
		}
	}

	async function toggleVideo() {
		const media = session.current;
		if (!media || busy) return;
		setBusy(true);
		try {
			if (videoOn) {
				setVideoOn(false);
				await media.stopVideo();
				const current = localRef.current;
				if (current) {
					for (const track of current.stream.getVideoTracks()) current.stream.removeTrack(track);
					const next = { ...current, video: null };
					localRef.current = next;
					onLocal(next);
				}
			} else {
				const track = await openCamera();
				if (!track) {
					toast({ message: "The browser does not let this page use your camera." });
					return;
				}
				await media.startVideo(track);
				const current = localRef.current;
				const stream = current?.stream ?? new MediaStream();
				stream.addTrack(track);
				const next: LocalMedia = { stream, audio: current?.audio ?? null, video: track, problem: null };
				localRef.current = next;
				onLocal(next);
				setVideoOn(true);
			}
		} catch (error) {
			toast({ message: errorMessage(error), tone: "error" });
		} finally {
			setBusy(false);
		}
	}

	async function leave() {
		watch.current?.stop();
		try {
			await callApi.leave(code, token);
		} catch {
			// The server drops an absent participant later.
		}
		session.current?.close();
		onOver("left");
	}

	async function decide(entry: { id: string }, decision: "admit" | "deny" | "remove") {
		try {
			const input = { code, participant_id: entry.id };
			if (decision === "admit") await api.call("meet.admit_participant", input);
			else if (decision === "deny") await api.call("meet.deny_participant", input);
			else await api.call("meet.remove_participant", input);
			watch.current?.refresh();
		} catch (error) {
			toast({ message: errorMessage(error), tone: "error" });
		}
	}

	const self = state?.self;
	const isHost = self?.role === "host";
	const others = (state?.participants ?? []).filter((entry) => entry.id !== self?.id);
	const lobby = state?.lobby ?? [];
	const notice = STATUS_TEXT[status];

	return (
		<main className="meet-page meet-call">
			<header className="meet-call-header">
				<h1 className="meet-call-title">{info.title || "Meeting"}</h1>
				<span className="meet-muted">
					{others.length + 1} {others.length === 0 ? "participant" : "participants"}
				</span>
			</header>
			{notice && (
				<div className={`meet-banner${status === "failed" ? " meet-banner-error" : ""}`} role="status">
					{notice}
					{status === "failed" && (
						<button type="button" className="button button-small" onClick={() => session.current?.restart()}>
							Try again
						</button>
					)}
				</div>
			)}
			{soundBlocked && (
				<div className="meet-banner" role="status">
					The browser blocked the sound of the call.
					<button
						type="button"
						className="button button-small"
						onClick={() => {
							for (const element of document.querySelectorAll<HTMLAudioElement>("audio.meet-audio")) {
								void element.play().catch(() => {});
							}
							setSoundBlocked(false);
						}}
					>
						Turn on sound
					</button>
				</div>
			)}
			<div className="meet-body">
				<section className={`meet-grid meet-grid-${Math.min(others.length + 1, 9)}`} aria-label="Participants">
					<SelfTile name={self?.display_name ?? "You"} video={videoOn ? (local?.video ?? null) : null} muted={muted} />
					{others.map((entry) => (
						<RemoteTile
							key={entry.id}
							entry={entry}
							remote={remote}
							canRemove={isHost && entry.role !== "host"}
							onRemove={() => void decide(entry, "remove")}
							onSoundBlocked={blockSound}
						/>
					))}
				</section>
				{isHost && lobby.length > 0 && (
					<LobbyPanel lobby={lobby} onDecide={(entry, decision) => void decide(entry, decision)} />
				)}
			</div>
			<footer className="meet-controls meet-call-controls">
				<button
					type="button"
					className={`meet-round${muted ? " meet-round-off" : ""}`}
					aria-pressed={muted}
					disabled={!local?.audio}
					onClick={() => void toggleMute()}
				>
					<Icon name={muted ? "microphoneOff" : "microphone"} />
					<span className="visually-hidden">{muted ? "Unmute" : "Mute"}</span>
				</button>
				<button
					type="button"
					className={`meet-round${videoOn ? "" : " meet-round-off"}`}
					aria-pressed={!videoOn}
					disabled={busy}
					onClick={() => void toggleVideo()}
				>
					<Icon name={videoOn ? "video" : "videoOff"} />
					<span className="visually-hidden">{videoOn ? "Turn off camera" : "Turn on camera"}</span>
				</button>
				<button type="button" className="meet-round meet-round-leave" onClick={() => void leave()}>
					<Icon name="callEnd" />
					<span className="visually-hidden">Leave call</span>
				</button>
				{isHost && (
					<button type="button" className="button button-danger" onClick={() => setConfirmEnd(true)}>
						End call for everyone
					</button>
				)}
			</footer>
			{confirmEnd && (
				<ConfirmDialog
					title="End the call for everyone?"
					confirmLabel="End call"
					danger
					onConfirm={async () => {
						await api.call("meet.end_meeting", { code });
					}}
					onClose={() => setConfirmEnd(false)}
				>
					Each participant leaves the call, and nobody can join again with this link.
				</ConfirmDialog>
			)}
		</main>
	);
}

function SelfTile({ name, video, muted }: { name: string; video: MediaStreamTrack | null; muted: boolean }) {
	const ref = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		if (ref.current) ref.current.srcObject = video ? new MediaStream([video]) : null;
	}, [video]);
	return (
		<figure className="meet-tile" data-self="true">
			{video ? (
				<video ref={ref} className="meet-video meet-mirror" autoPlay playsInline muted aria-label="Your camera" />
			) : (
				<div className="meet-avatar" aria-hidden="true">
					{initials(name)}
				</div>
			)}
			<figcaption className="meet-tile-name">
				{name} (you){muted && <Icon name="microphoneOff" size={16} className="meet-tile-muted" />}
			</figcaption>
		</figure>
	);
}

interface RemoteTileProps {
	entry: RosterEntry;
	remote: ReadonlyMap<string, MediaStreamTrack>;
	canRemove: boolean;
	onRemove(): void;
	onSoundBlocked(): void;
}

function RemoteTile({ entry, remote, canRemove, onRemove, onSoundBlocked }: RemoteTileProps) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const audioRef = useRef<HTMLAudioElement>(null);
	const videoId = entry.tracks.find((track) => track.kind === "video")?.id;
	const audioId = entry.tracks.find((track) => track.kind === "audio")?.id;
	const video = videoId ? (remote.get(videoId) ?? null) : null;
	const audio = audioId ? (remote.get(audioId) ?? null) : null;

	useEffect(() => {
		if (videoRef.current) videoRef.current.srcObject = video ? new MediaStream([video]) : null;
	}, [video]);
	useEffect(() => {
		const element = audioRef.current;
		if (!element) return;
		element.srcObject = audio ? new MediaStream([audio]) : null;
		if (audio) element.play().catch(() => onSoundBlocked());
	}, [audio, onSoundBlocked]);

	return (
		<figure className="meet-tile" data-participant={entry.id}>
			{video ? (
				<video
					ref={videoRef}
					className="meet-video"
					autoPlay
					playsInline
					muted
					aria-label={`Video of ${entry.display_name}`}
				/>
			) : (
				<div className="meet-avatar" aria-hidden="true">
					{initials(entry.display_name)}
				</div>
			)}
			{/* biome-ignore lint/a11y/useMediaCaption: live call audio has no caption track */}
			<audio ref={audioRef} className="meet-audio" autoPlay />
			<figcaption className="meet-tile-name">
				{entry.display_name}
				{entry.kind === "guest" && <span className="meet-badge">Guest</span>}
				{entry.role === "host" && <span className="meet-badge">Host</span>}
				{entry.audio_muted && <Icon name="microphoneOff" size={16} className="meet-tile-muted" />}
				{!entry.connected && <span className="meet-badge">Connection lost</span>}
			</figcaption>
			{canRemove && (
				<button type="button" className="button button-small meet-tile-action" onClick={onRemove}>
					Remove<span className="visually-hidden"> {entry.display_name}</span>
				</button>
			)}
		</figure>
	);
}

function LobbyPanel({
	lobby,
	onDecide,
}: {
	lobby: readonly LobbyEntry[];
	onDecide(entry: LobbyEntry, decision: "admit" | "deny"): void;
}) {
	return (
		<aside className="meet-lobby-panel" aria-label="Waiting to join">
			<h2 className="meet-panel-title">Waiting to join ({lobby.length})</h2>
			<ul className="meet-lobby-list">
				{lobby.map((entry) => (
					<li key={entry.id} className="meet-lobby-entry">
						<span className="meet-lobby-name">
							{entry.display_name}
							{entry.kind === "guest" && <span className="meet-badge">Guest</span>}
						</span>
						<span className="meet-lobby-actions">
							<button
								type="button"
								className="button button-small button-primary"
								onClick={() => onDecide(entry, "admit")}
							>
								Admit<span className="visually-hidden"> {entry.display_name}</span>
							</button>
							<button type="button" className="button button-small" onClick={() => onDecide(entry, "deny")}>
								Deny<span className="visually-hidden"> {entry.display_name}</span>
							</button>
						</span>
					</li>
				))}
			</ul>
		</aside>
	);
}

function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	const letters = parts.length > 1 ? [parts[0], parts.at(-1)] : [parts[0]];
	return letters
		.map((part) => part?.[0] ?? "")
		.join("")
		.toUpperCase();
}
