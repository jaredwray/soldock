import { type FormEvent, useState } from "react";
import { Icon } from "../lib/icons.tsx";
import { Link, navigate } from "../lib/router.tsx";
import { useOnChange } from "../lib/useOnChange.ts";
import { CHAT_PATH, DRIVE_PATH, drivePath, INBOX_PATH, type Route, viewPath } from "../routes.ts";
import { AccountMenu } from "./AccountMenu.tsx";

/** The element id of the search box. The `/` shortcut moves the focus to it. */
export const SEARCH_INPUT_ID = "app-search";

/** The element id of the menu button. The focus goes back to it when the navigation drawer closes. */
export const MENU_BUTTON_ID = "app-menu-button";

/** The element ids of the navigation drawers. The menu button controls the drawer of the current product. */
export const MAIL_NAV_ID = "mail-nav";
export const DRIVE_NAV_ID = "drive-nav";
export const CHAT_NAV_ID = "chat-nav";
export const ADMIN_NAV_ID = "admin-nav";

/** The products of Soldock. A doc and a sheet are part of Drive. */
export type Product = "mail" | "drive" | "chat";

export function productOf(route: Route): Product {
	if (route.page === "chat") return "chat";
	return route.page === "drive" || route.page === "doc" || route.page === "sheet" ? "drive" : "mail";
}

const PRODUCTS = [
	{ product: "mail", name: "Mail", icon: "mail", home: INBOX_PATH, label: "Soldock Mail, go to the inbox" },
	{ product: "drive", name: "Drive", icon: "drive", home: DRIVE_PATH, label: "Soldock Drive, go to your drive" },
	{ product: "chat", name: "Chat", icon: "chat", home: CHAT_PATH, label: "Soldock Chat, go to your rooms" },
] as const;

/** The pages with a navigation drawer, and the element id of each drawer. */
const NAV_IDS: Partial<Record<Route["page"], string>> = {
	mail: MAIL_NAV_ID,
	drive: DRIVE_NAV_ID,
	chat: CHAT_NAV_ID,
	admin: ADMIN_NAV_ID,
};

interface TopBarProps {
	route: Route;
	navOpen: boolean;
	onToggleNav: () => void;
}

export function TopBar({ route, navOpen, onToggleNav }: TopBarProps) {
	const product = productOf(route);
	const current = PRODUCTS.find((entry) => entry.product === product) ?? PRODUCTS[0];
	// Only the pages with a navigation drawer get the menu button.
	const navId = NAV_IDS[route.page] ?? null;
	return (
		<header className="topbar">
			{navId && (
				<button
					id={MENU_BUTTON_ID}
					type="button"
					className="icon-button menu-button"
					aria-label="Main menu"
					aria-expanded={navOpen}
					aria-controls={navId}
					onClick={onToggleNav}
				>
					<Icon name="menu" />
				</button>
			)}
			<Link to={current.home} className="brand" aria-label={current.label}>
				<span className="brand-mark" aria-hidden="true">
					<Icon name={current.icon} size={18} />
				</span>
				<span className="brand-name">Soldock</span>
			</Link>
			{/* Chat has no search yet. The empty element keeps the products at the right. */}
			{product === "chat" ? <div className="search" /> : <SearchBox route={route} product={product} />}
			<nav className="product-nav" aria-label="Products">
				{PRODUCTS.map((entry) => (
					<Link
						key={entry.product}
						to={entry.home}
						className={entry.product === product ? "product-link product-link-active" : "product-link"}
						aria-current={entry.product === product ? "true" : undefined}
						title={entry.name}
					>
						<Icon name={entry.icon} />
						<span className="product-name">{entry.name}</span>
					</Link>
				))}
			</nav>
			<AccountMenu />
		</header>
	);
}

/** The search box of the current product: mail in Mail, and items in Drive. */
function SearchBox({ route, product }: { route: Route; product: Exclude<Product, "chat"> }) {
	const current =
		(route.page === "mail" || route.page === "drive") && route.view.kind === "search" ? route.view.query : "";
	const [value, setValue] = useState(current);
	// A search from a team mailbox stays in that mailbox.
	const mailboxId = route.page === "mail" ? route.mailboxId : null;
	const label = product === "drive" ? "Search in Drive" : "Search mail";

	useOnChange(current, () => setValue(current));

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const query = value.trim();
		if (product === "drive") {
			navigate(drivePath(query ? { kind: "search", query } : { kind: "folder", spaceId: null, folderId: null }));
		} else {
			navigate(viewPath(query ? { kind: "search", query } : { kind: "system", view: "inbox" }, mailboxId));
		}
		(document.activeElement as HTMLElement | null)?.blur();
	}

	return (
		<search className="search">
			<form onSubmit={submit}>
				<label htmlFor={SEARCH_INPUT_ID} className="visually-hidden">
					{label}
				</label>
				<Icon name="search" className="search-icon" />
				<input
					id={SEARCH_INPUT_ID}
					className="search-input"
					type="search"
					placeholder={label}
					autoComplete="off"
					spellCheck={false}
					value={value}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") event.currentTarget.blur();
					}}
				/>
			</form>
		</search>
	);
}
