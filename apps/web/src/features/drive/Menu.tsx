import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../../lib/icons.tsx";

export interface MenuItem {
	key: string;
	label: string;
	icon: IconName;
	danger?: boolean;
	onSelect: () => void;
}

interface MenuProps {
	/** The accessible name of the button, for a button that shows only an icon. */
	label?: string;
	/** The accessible name of the menu. The default is `label`. */
	menuLabel?: string;
	title?: string;
	className: string;
	children: ReactNode;
	items: readonly MenuItem[];
	/** The side of the button that the menu lines up with. */
	align?: "start" | "end";
	disabled?: boolean;
}

interface Position {
	top: number;
	left: number;
}

const GAP = 4;
const EDGE = 8;

/**
 * A button that opens a menu of actions. The menu has a fixed position, so a list that scrolls
 * cannot cut it. The arrow keys, Home and End move between the items. Escape and Tab close the
 * menu. After Escape or a selection, the focus goes back to the button.
 */
export function Menu({ label, menuLabel, title, className, children, items, align = "end", disabled }: MenuProps) {
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<Position | null>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const menuId = useId();

	// The menu goes below the button, or above it when the window has no room below.
	useLayoutEffect(() => {
		const button = buttonRef.current;
		const menu = menuRef.current;
		if (!open || !button || !menu) return;
		const anchor = button.getBoundingClientRect();
		const size = menu.getBoundingClientRect();
		const below = anchor.bottom + GAP;
		const top =
			below + size.height + EDGE <= window.innerHeight ? below : Math.max(EDGE, anchor.top - GAP - size.height);
		const wanted = align === "end" ? anchor.right - size.width : anchor.left;
		const left = Math.max(EDGE, Math.min(wanted, window.innerWidth - size.width - EDGE));
		setPosition({ top, left });
	}, [open, align]);

	// A hidden element cannot get the focus, so the first item gets it after the menu has its place.
	const placed = position !== null;
	useEffect(() => {
		if (placed) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
	}, [placed]);

	useEffect(() => {
		if (!open) return;
		const close = () => setOpen(false);
		function onPointerDown(event: PointerEvent) {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close();
		}
		document.addEventListener("pointerdown", onPointerDown);
		// The position belongs to the place of the button at the time of the click.
		window.addEventListener("resize", close);
		window.addEventListener("scroll", close, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("resize", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [open]);

	function close(returnFocus: boolean) {
		setOpen(false);
		setPosition(null);
		if (returnFocus) buttonRef.current?.focus();
	}

	function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		const entries = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
		const index = entries.indexOf(document.activeElement as HTMLElement);
		const last = entries.length - 1;
		let next: number | null = null;
		if (event.key === "ArrowDown") next = index >= last ? 0 : index + 1;
		else if (event.key === "ArrowUp") next = index <= 0 ? last : index - 1;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = last;
		else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close(true);
			return;
		} else if (event.key === "Tab") {
			close(false);
			return;
		}
		if (next === null) return;
		event.preventDefault();
		entries[next]?.focus();
	}

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				className={className}
				aria-label={label}
				title={title ?? label}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
				disabled={disabled}
				onClick={() => (open ? close(false) : setOpen(true))}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" && !open) {
						event.preventDefault();
						setOpen(true);
					}
				}}
			>
				{children}
			</button>
			{open && (
				<div
					ref={menuRef}
					id={menuId}
					role="menu"
					aria-label={menuLabel ?? label}
					className="drive-menu"
					style={position ? { top: position.top, left: position.left } : { top: 0, left: 0, visibility: "hidden" }}
					onKeyDown={onMenuKeyDown}
				>
					{items.map((item) => (
						<button
							key={item.key}
							type="button"
							role="menuitem"
							tabIndex={-1}
							className={item.danger ? "drive-menu-item drive-menu-item-danger" : "drive-menu-item"}
							onClick={() => {
								close(true);
								item.onSelect();
							}}
						>
							<Icon name={item.icon} size={18} />
							{item.label}
						</button>
					))}
				</div>
			)}
		</>
	);
}
