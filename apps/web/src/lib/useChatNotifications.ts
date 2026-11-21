import { useEffect } from "react";
import { currentAccount } from "./account.ts";
import { api } from "./api.ts";
import { setChatUnread } from "./pageTitle.ts";
import { onPrincipalEvent, principalSocketLive, startPrincipalSocket } from "./principalSocket.ts";
import { activeChatTab } from "./usePrincipalActivity.ts";

/** The browser permits audio after a gesture. Only an active tab plays the tone. */
function messageSound() {
	let audio: AudioContext | undefined;
	function unlock() {
		if (!("AudioContext" in window)) return;
		audio ??= new AudioContext();
		if (audio.state === "suspended") void audio.resume().catch(() => {});
	}
	window.addEventListener("pointerdown", unlock);
	window.addEventListener("keydown", unlock);
	return {
		play() {
			if (audio?.state !== "running" || !activeChatTab()) return;
			const tone = audio.createOscillator();
			const volume = audio.createGain();
			tone.frequency.value = 660;
			volume.gain.setValueAtTime(0.055, audio.currentTime);
			volume.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.16);
			tone.connect(volume).connect(audio.destination);
			tone.start();
			tone.stop(audio.currentTime + 0.17);
		},
		close() {
			window.removeEventListener("pointerdown", unlock);
			window.removeEventListener("keydown", unlock);
			void audio?.close().catch(() => {});
		},
	};
}

/** Keep the count for the whole account, including rooms outside the first page of the sidebar. */
export function useChatNotifications(account: string): void {
	useEffect(() => {
		let stopped = false;
		let revision = 0;
		let request = 0;
		const sound = messageSound();
		let retry: number | undefined;
		let retryDelay = 2000;
		let incomplete = true;
		function retryRead() {
			incomplete = true;
			if (document.visibilityState !== "visible") return;
			retry = window.setTimeout(refresh, retryDelay);
			retryDelay = Math.min(retryDelay * 2, 60_000);
		}
		function refresh() {
			window.clearTimeout(retry);
			const since = revision;
			const current = ++request;
			const currentRead = () => !stopped && currentAccount() === account && current === request;
			void api.call("chat.get_notification_settings", {}).then(
				({ unread_count, unread_complete }) => {
					if (!currentRead()) return;
					if (since === revision) setChatUnread(unread_count);
					incomplete = !unread_complete;
					if (incomplete) retryRead();
					else retryDelay = 2000;
				},
				() => {
					if (currentRead()) retryRead();
				},
			);
		}
		const resume = () => {
			if (incomplete && document.visibilityState === "visible") refresh();
		};
		const unsubscribe = onPrincipalEvent((event) => {
			if (currentAccount() !== account) return;
			if (event.type === "hello") refresh();
			if (event.type === "chat.unread") {
				revision++;
				setChatUnread(event.unread_count);
			}
			if (event.type === "chat.notification") sound.play();
		});
		const stopSocket = startPrincipalSocket();
		// A fast hello cancels the initial read. A tab without a socket still gets its count.
		retry = window.setTimeout(refresh, 1000);
		document.addEventListener("visibilitychange", resume);
		const fallback = window.setInterval(() => {
			if (!incomplete && !principalSocketLive() && document.visibilityState === "visible") refresh();
		}, 30_000);
		return () => {
			stopped = true;
			window.clearInterval(fallback);
			window.clearTimeout(retry);
			document.removeEventListener("visibilitychange", resume);
			unsubscribe();
			stopSocket();
			sound.close();
			setChatUnread(0);
		};
	}, [account]);
}
