import type { IceServer, RosterEntry } from "@asterra/contracts";
import { callApi } from "./callApi.ts";

// The media of one participant: one RTCPeerConnection to the Cloudflare Realtime SFU, which sends the local tracks
// and receives the tracks of the others. The browser never talks to the SFU API: each step goes through Asterra,
// which checks that the participant is admitted. The connection never restarts ICE: the SFU has no ICE restart. On
// a lost connection, the session starts again with a new connection, and sends and receives the same tracks.

export type MediaStatus = "idle" | "connecting" | "connected" | "reconnecting" | "failed";

export interface MediaEvents {
	status(status: MediaStatus): void;
	/** A remote track arrived, or it changed after a new session. */
	track(trackId: string, track: MediaStreamTrack): void;
	/** A remote track is gone. */
	removed(trackId: string): void;
}

const GATHER_MS = 3000;
const DISCONNECTED_MS = 5000;
const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000];

async function gathered(pc: RTCPeerConnection): Promise<void> {
	if (pc.iceGatheringState === "complete") return;
	await new Promise<void>((done) => {
		const timer = setTimeout(done, GATHER_MS);
		const check = () => {
			if (pc.iceGatheringState === "complete") {
				clearTimeout(timer);
				pc.removeEventListener("icegatheringstatechange", check);
				done();
			}
		};
		pc.addEventListener("icegatheringstatechange", check);
	});
}

function toRtcServers(servers: readonly IceServer[]): RTCIceServer[] {
	return servers.map((server) => ({
		urls: server.urls,
		...(server.username === undefined ? {} : { username: server.username }),
		...(server.credential === undefined ? {} : { credential: server.credential }),
	}));
}

export class MediaSession {
	private pc: RTCPeerConnection | null = null;
	private session = 0;
	private queue: Promise<unknown> = Promise.resolve();
	private closed = false;
	private generation = 0;
	private status: MediaStatus = "idle";
	private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
	/** The local tracks to send. A null track is not sent. */
	private local: { audio: MediaStreamTrack | null; video: MediaStreamTrack | null } = { audio: null, video: null };
	/** The transceiver of each local kind in the current connection. */
	private senders = new Map<"audio" | "video", RTCRtpTransceiver>();
	/** The remote tracks that the connection receives now: track id to mid. */
	private pulled = new Map<string, string>();
	/** The remote tracks that the roster has now. */
	private wanted = new Set<string>();

	private readonly code: string;
	private readonly token: string;
	private readonly events: MediaEvents;

	constructor(code: string, token: string, events: MediaEvents) {
		this.code = code;
		this.token = token;
		this.events = events;
	}

	/** The connection, for a test that reads its statistics. */
	get connection(): RTCPeerConnection | null {
		return this.pc;
	}

	private setStatus(status: MediaStatus): void {
		if (this.status === status) return;
		this.status = status;
		this.events.status(status);
	}

	/** Runs `step` after the earlier steps. The SFU needs the changes of one session in order. */
	private run<T>(step: () => Promise<T>): Promise<T> {
		const next = this.queue.catch(() => undefined).then(step);
		this.queue = next.catch(() => undefined);
		return next;
	}

	/** Starts the media with the local tracks. Each later step waits for it. */
	start(local: { audio: MediaStreamTrack | null; video: MediaStreamTrack | null }): Promise<void> {
		this.local = { ...local };
		return this.run(() => this.connect(false));
	}

	/** A new SFU session and a new connection. It sends the local tracks and receives the wanted tracks again. */
	private async connect(again: boolean): Promise<void> {
		if (this.closed) return;
		const generation = ++this.generation;
		this.setStatus(again ? "reconnecting" : "connecting");
		this.pc?.close();
		this.pc = null;
		this.senders.clear();
		for (const trackId of this.pulled.keys()) this.events.removed(trackId);
		this.pulled.clear();
		const started = await callApi.session(this.code, this.token);
		if (this.closed || generation !== this.generation) return;
		this.session = started.session;
		const pc = new RTCPeerConnection({ iceServers: toRtcServers(started.ice_servers), bundlePolicy: "max-bundle" });
		this.pc = pc;
		pc.addEventListener("connectionstatechange", () => this.watch(pc, generation));
		await this.publish((["audio", "video"] as const).filter((kind) => this.local[kind] !== null));
		await this.pull();
		if (pc.connectionState === "connected") this.setStatus("connected");
	}

	private watch(pc: RTCPeerConnection, generation: number): void {
		if (generation !== this.generation || this.closed) return;
		const state = pc.connectionState;
		if (state === "connected") {
			if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
			this.disconnectTimer = null;
			this.setStatus("connected");
		} else if (state === "failed" || state === "closed") {
			// Only an old connection closes on purpose, and it has an old generation. A close of the current one is a loss.
			this.restart();
		} else if (state === "disconnected" && !this.disconnectTimer) {
			this.disconnectTimer = setTimeout(() => {
				this.disconnectTimer = null;
				if (generation === this.generation && pc.connectionState !== "connected") this.restart();
			}, DISCONNECTED_MS);
		}
	}

	/** Starts again after a lost connection, with a few tries. */
	restart(): void {
		if (this.closed) return;
		void this.run(async () => {
			for (const delay of RETRY_DELAYS) {
				if (this.closed) return;
				try {
					await this.connect(true);
					return;
				} catch (error) {
					// A participant that the host removed, or a meeting that ended, cannot start again.
					if (isFinal(error)) {
						this.setStatus("failed");
						return;
					}
					await new Promise((done) => setTimeout(done, delay));
				}
			}
			this.setStatus("failed");
		});
	}

	/** Sends local tracks of these kinds in new transceivers. */
	private async publish(kinds: readonly ("audio" | "video")[]): Promise<void> {
		const pc = this.pc;
		if (!pc || kinds.length === 0) return;
		const added: { kind: "audio" | "video"; transceiver: RTCRtpTransceiver }[] = [];
		for (const kind of kinds) {
			const track = this.local[kind];
			if (!track) continue;
			const transceiver = pc.addTransceiver(track, { direction: "sendonly" });
			this.senders.set(kind, transceiver);
			added.push({ kind, transceiver });
		}
		if (added.length === 0) return;
		await pc.setLocalDescription(await pc.createOffer());
		await gathered(pc);
		const result = await callApi.publish(this.code, this.token, {
			session: this.session,
			offer: { sdp: pc.localDescription?.sdp ?? "" },
			tracks: added.map(({ kind, transceiver }) => ({ mid: transceiver.mid ?? "", kind })),
		});
		await pc.setRemoteDescription({ type: "answer", sdp: result.answer.sdp });
	}

	/** Changes the remote tracks to receive, from the roster of the meeting. */
	follow(roster: readonly RosterEntry[], selfId: string): void {
		const next = new Set<string>();
		for (const entry of roster) {
			if (entry.id === selfId) continue;
			for (const track of entry.tracks) next.add(track.id);
		}
		this.wanted = next;
		for (const trackId of [...this.pulled.keys()]) {
			if (!next.has(trackId)) {
				// The server closed the pull on the SFU. The transceiver stays, without media.
				this.pulled.delete(trackId);
				this.events.removed(trackId);
			}
		}
		if ([...next].some((trackId) => !this.pulled.has(trackId))) void this.run(() => this.pull()).catch(() => {});
	}

	private async pull(): Promise<void> {
		const pc = this.pc;
		if (!pc) return;
		const missing = [...this.wanted].filter((trackId) => !this.pulled.has(trackId));
		if (missing.length === 0) return;
		const result = await callApi.subscribe(this.code, this.token, { session: this.session, track_ids: missing });
		if (result.offer) {
			await pc.setRemoteDescription({ type: "offer", sdp: result.offer.sdp });
			await pc.setLocalDescription(await pc.createAnswer());
			await gathered(pc);
			await callApi.answer(this.code, this.token, {
				session: this.session,
				answer: { sdp: pc.localDescription?.sdp ?? "" },
			});
		}
		for (const { id, mid } of result.tracks) {
			const transceiver = pc.getTransceivers().find((item) => item.mid === mid);
			if (!transceiver || !this.wanted.has(id)) continue;
			this.pulled.set(id, mid);
			this.events.track(id, transceiver.receiver.track);
		}
	}

	/** Mutes or unmutes the microphone. The track keeps sending silence, so the SFU keeps it. */
	async setMuted(muted: boolean): Promise<void> {
		if (this.local.audio) this.local.audio.enabled = !muted;
		await callApi.mediaState(this.code, this.token, muted);
	}

	/** Stops the camera: the others stop receiving it, and the camera light goes off. */
	async stopVideo(): Promise<void> {
		await this.run(async () => {
			const transceiver = this.senders.get("video");
			const track = this.local.video;
			this.local.video = null;
			track?.stop();
			if (!transceiver || !this.pc) return;
			this.senders.delete("video");
			await transceiver.sender.replaceTrack(null);
			transceiver.direction = "inactive";
			await callApi.unpublish(this.code, this.token, { session: this.session, kinds: ["video"] });
		});
	}

	/** Sends a new camera track. */
	async startVideo(track: MediaStreamTrack): Promise<void> {
		await this.run(async () => {
			this.local.video = track;
			await this.publish(["video"]);
		});
	}

	/** The audio track that the microphone gives now, or null. */
	get audioTrack(): MediaStreamTrack | null {
		return this.local.audio;
	}

	close(): void {
		this.closed = true;
		this.generation++;
		if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
		this.pc?.close();
		this.pc = null;
		this.setStatus("idle");
	}
}

function isFinal(error: unknown): boolean {
	const status = (error as { status?: number } | null)?.status;
	return status === 401 || status === 403 || status === 404;
}
