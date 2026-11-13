// Line icons, drawn for Soldock on a 24 by 24 grid. Each icon is decoration only: the button or
// link that holds it has the accessible name.

const PATHS = {
	menu: "M4 6h16M4 12h16M4 18h16",
	search: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4",
	star: "M12 3l2.8 5.8 6.2.8-4.5 4.3 1.1 6.1-5.6-3-5.6 3 1.1-6.1L3 9.6l6.2-.8z",
	archive: "M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v3H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4",
	trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
	mailOpen: "M3 10l9-6 9 6v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 10l9 6 9-6",
	team: "M9 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM3 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1M16 5.2a3 3 0 0 1 0 5.6M18 14.3a5 5 0 0 1 3 4.7v1",
	mail: "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 7l9 6 9-6",
	tag: "M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9zM7.5 6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z",
	folder: "M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
	spam: "M8 3h8l5 5v8l-5 5H8l-5-5V8zM12 8v5M12 16h.01",
	restore: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
	back: "M19 12H5M12 19l-7-7 7-7",
	reply: "M9 17l-5-5 5-5M4 12h11a5 5 0 0 1 5 5v2",
	replyAll: "M7 17l-5-5 5-5M12 17l-5-5 5-5M7 12h9a5 5 0 0 1 5 5v2",
	forward: "M15 17l5-5-5-5M20 12H9a5 5 0 0 0-5 5v2",
	paperclip: "M20 11.5l-8.5 8.5a5 5 0 0 1-7-7L13 4.5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7.5",
	plus: "M12 5v14M5 12h14",
	close: "M6 6l12 12M18 6L6 18",
	pencil: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
	download: "M12 4v11M7 10l5 5 5-5M5 20h14",
	warning: "M12 3L2 20h20zM12 9v5M12 17h.01",
	inbox: "M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 13h5l1 3h6l1-3h5",
	send: "M21 3L10 14M21 3l-7 18-4-7-7-4z",
	allMail: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
	settings: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4",
	shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
	keyboard:
		"M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10",
	refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
	copy: "M10 8h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM15 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h4",
	signOut: "M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11",
	chevronDown: "M6 9l6 6 6-6",
	external: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
	bold: "M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z",
	italic: "M10 5h8M6 19h8M14 5l-4 14",
	underline: "M7 4v7a5 5 0 0 0 10 0V4M5 20h14",
	strikethrough:
		"M4 12h16M16.5 7c-.6-1.5-2.3-2.5-4.5-2.5-2.5 0-4.5 1.3-4.5 3.3 0 1.6 1.2 2.6 3 3.2M8 16.5c.6 1.7 2.3 3 4.5 3 2.5 0 4.5-1.4 4.5-3.4 0-1-.4-1.8-1.2-2.4",
	link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
	listBulleted: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
	listNumbered: "M10 6h10M10 12h10M10 18h10M4 4.5l1.5-1V9M3.5 14a1.5 1.5 0 0 1 3 0c0 1-3 2.5-3 4.5h3",
	quote: "M5 5v14M10 8h9M10 12h9M10 16h6",
	clearFormat: "M6 5h11M11.5 5l-3 14M14 14l6 6M20 14l-6 6",
	heading: "M6 5v14M18 5v14M6 12h12",
	code: "M8 7l-5 5 5 5M16 7l5 5-5 5",
	rule: "M4 12h16",
	undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
	redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
	drive: "M5 4h14l3 10v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-5zM2 14h20M6 17h.01M10 17h.01",
	file: "M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5",
	doc: "M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M9 13h6M9 17h6",
	sheet: "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM3 10h18M3 15h18M9 4v16",
	image: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 16l5-5 4 4 3-3 6 6M15.5 9h.01",
	folderPlus: "M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM12 11v5M9.5 13.5h5",
	folderMove: "M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM9 13.5h6M13 11l2.5 2.5L13 16",
	upload: "M12 16V5M7 10l5-5 5 5M5 20h14",
	share: "M10 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM3 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 2 .4M18 14v6M15 17h6",
	more: "M12 5h.01M12 12h.01M12 19h.01",
	history: "M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5M12 8v4l3 2",
	clock: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7v5l3 2",
	info: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 11v6M12 7.5h.01",
	check: "M5 12l5 5 9-10",
	chevronRight: "M9 6l6 6-6 6",
	eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z",
	codeBlock: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM10 9l-3 3 3 3M14 9l3 3-3 3",
	chat: "M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 9h8M8 13h5",
	hash: "M9 4L7 20M17 4l-2 16M4 9h17M3 15h17",
	bot: "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM12 4v4M9 13h.01M15 13h.01M10 17h4M2 13v2M22 13v2",
	lock: "M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V7a4 4 0 0 1 8 0v4",
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps {
	name: IconName;
	size?: number;
	/** Fill the shape with the current color, for example a set star. */
	filled?: boolean;
	className?: string;
}

export function Icon({ name, size = 20, filled = false, className }: IconProps) {
	return (
		<svg
			className={className ? `icon ${className}` : "icon"}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill={filled ? "currentColor" : "none"}
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			<path d={PATHS[name]} />
		</svg>
	);
}
