import { type ChatCustomEmoji, isCustomEmoji } from "@asterra/contracts";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api.ts";

export interface CustomEmojiState {
	list: readonly ChatCustomEmoji[];
	byName: ReadonlyMap<string, ChatCustomEmoji>;
	refresh: () => Promise<void>;
}

const EMPTY: CustomEmojiState = {
	list: [],
	byName: new Map(),
	refresh: async () => {},
};

const CustomEmojiContext = createContext<CustomEmojiState>(EMPTY);

export function CustomEmojiProvider({ children }: { children: ReactNode }) {
	const [list, setList] = useState<readonly ChatCustomEmoji[]>([]);

	const refresh = useCallback(async () => {
		try {
			const res = await api.call("chat.list_custom_emoji");
			setList(res.emoji);
		} catch {
			// Keep the previous list if loading fails.
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const value = useMemo<CustomEmojiState>(() => {
		const byName = new Map<string, ChatCustomEmoji>();
		for (const item of list) byName.set(item.name, item);
		return { list, byName, refresh };
	}, [list, refresh]);

	return <CustomEmojiContext.Provider value={value}>{children}</CustomEmojiContext.Provider>;
}

export function useCustomEmoji(): CustomEmojiState {
	return useContext(CustomEmojiContext);
}

/** Renders either a Unicode emoji or a custom `:name:` raster emoji image. */
export function EmojiGlyph({ emoji, className }: { emoji: string; className?: string }) {
	const { byName } = useCustomEmoji();
	if (isCustomEmoji(emoji)) {
		const name = emoji.slice(1, -1);
		const custom = byName.get(name);
		if (custom) {
			return (
				<img
					src={custom.url_path}
					alt={emoji}
					title={emoji}
					className={className ? `chat-custom-emoji ${className}` : "chat-custom-emoji"}
				/>
			);
		}
	}
	return <span className={className}>{emoji}</span>;
}
