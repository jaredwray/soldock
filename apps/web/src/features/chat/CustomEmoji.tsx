import { CUSTOM_EMOJI_LIMITS } from "@asterra/contracts";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fileToBase64 } from "../../lib/base64.ts";
import { isOrgAdmin, useSession } from "../auth/session.tsx";

import { EMOJI, type EmojiChoice } from "./emoji.ts";

const Catalog = createContext<{
	names: ReadonlySet<string>;
	choices: readonly EmojiChoice[];
	refresh: () => Promise<void>;
}>({
	names: new Set(),
	choices: EMOJI,
	refresh: async () => {},
});

export function CustomEmojiProvider({ children }: { children: ReactNode }) {
	const [names, setNames] = useState<ReadonlySet<string>>(new Set());
	const request = useRef(0);
	const refresh = useCallback(async () => {
		const version = ++request.current;
		const result = await api.call("chat.list_emoji");
		if (request.current === version) setNames(new Set(result.names));
	}, []);
	useEffect(() => {
		const load = () => {
			void refresh().catch(() => {});
		};
		load();
		window.addEventListener("focus", load);
		return () => {
			request.current++;
			window.removeEventListener("focus", load);
		};
	}, [refresh]);
	const choices = useMemo(
		() => [...EMOJI, ...Array.from(names, (name) => ({ name, emoji: `:${name}:`, words: [] }))],
		[names],
	);
	return <Catalog.Provider value={{ names, choices, refresh }}>{children}</Catalog.Provider>;
}

export function useCustomEmoji() {
	return useContext(Catalog);
}

export function EmojiText({ text }: { text: string }) {
	const { names } = useCustomEmoji();
	if (!names.size || !text.includes(":")) return text;
	const parts: ReactNode[] = [];
	let start = 0;
	for (const match of text.matchAll(/:([a-z0-9_+-]{1,30}):/g)) {
		const name = match[1];
		if (!name || !names.has(name)) continue;
		parts.push(
			text.slice(start, match.index),
			<img
				key={match.index}
				width="20"
				height="20"
				className="chat-emoji-image"
				alt={match[0]}
				title={match[0]}
				src={`/dl/chat-emoji/${encodeURIComponent(name)}`}
			/>,
		);
		start = match.index + match[0].length;
	}
	return start ? (
		<>
			{parts}
			{text.slice(start)}
		</>
	) : (
		text
	);
}

export function ManageEmoji() {
	const { whoami } = useSession();
	const { names, refresh } = useCustomEmoji();
	const [name, setName] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	if (!isOrgAdmin(whoami.principal)) return null;
	async function save(remove: boolean) {
		setBusy(true);
		setError("");
		try {
			if (remove) await api.call("chat.delete_emoji", { name });
			else if (file) {
				if (file.size > CUSTOM_EMOJI_LIMITS.bytes) throw new Error("Choose a PNG file up to 32 KiB.");
				await api.call("chat.create_emoji", { name, content_base64: await fileToBase64(file) });
			}
			await refresh();
			setName("");
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}
	return (
		<details className="chat-custom-emoji">
			<summary>Manage custom emoji</summary>
			<label>
				Name
				<input
					className="input"
					value={name}
					maxLength={30}
					placeholder="team_logo"
					onChange={(event) => setName(event.target.value)}
				/>
			</label>
			<label>
				PNG, up to 128 × 128 pixels
				<input type="file" accept="image/png" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
			</label>
			{names.has(name) ? (
				<button type="button" className="button" disabled={busy} onClick={() => void save(true)}>
					Remove :{name}:
				</button>
			) : (
				<button
					type="button"
					className="button"
					disabled={busy || !file || !/^[a-z0-9_+-]{1,30}$/.test(name)}
					onClick={() => void save(false)}
				>
					Add emoji
				</button>
			)}
			{error && <p role="alert">{error}</p>}
		</details>
	);
}
