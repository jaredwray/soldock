import type { ChatRoom, RoomSection } from "@asterra/contracts";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";

/** A room has the same position across pages even if it moves to a different section during the read. */
export function useSidebarSections(roomRevision: number) {
	const [sections, setSections] = useState<RoomSection[]>([]);
	const [sectionError, setSectionError] = useState("");
	const [sectionRevision, setSectionRevision] = useState(0);
	useEffect(() => {
		void sectionRevision;
		void roomRevision;
		let active = true;
		async function read() {
			let cursor: string | null = null;
			const sections = new Map<string, Map<string, ChatRoom>>();
			do {
				const page: { sections: RoomSection[]; next_cursor: string | null } = await api.call(
					"chat.list_sections",
					cursor ? { cursor } : {},
				);
				if (!active) return;
				for (const section of page.sections) {
					const rooms = sections.get(section.name) ?? new Map<string, ChatRoom>();
					for (const room of section.rooms) rooms.set(room.id, room);
					sections.set(section.name, rooms);
				}
				cursor = page.next_cursor;
			} while (cursor !== null);
			setSections(
				[...sections]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([name, rooms]) => ({ name, rooms: [...rooms.values()] })),
			);
			setSectionError("");
		}
		read().catch((error) => {
			if (active) setSectionError(errorMessage(error));
		});
		return () => {
			active = false;
		};
	}, [sectionRevision, roomRevision]);
	return { sections, sectionError, refreshSections: () => setSectionRevision((n) => n + 1) };
}
