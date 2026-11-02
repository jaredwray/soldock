import { type FormEvent, useState } from "react";
import { Icon } from "../lib/icons.tsx";
import { Link, navigate } from "../lib/router.tsx";
import { useOnChange } from "../lib/useOnChange.ts";
import { INBOX_PATH, type Route, viewPath } from "../routes.ts";
import { AccountMenu } from "./AccountMenu.tsx";

/** The element id of the search box. The `/` shortcut moves the focus to it. */
export const SEARCH_INPUT_ID = "mail-search";

interface TopBarProps {
	route: Route;
	navOpen: boolean;
	onToggleNav: () => void;
}

export function TopBar({ route, navOpen, onToggleNav }: TopBarProps) {
	const isMail = route.page === "mail";
	return (
		<header className="topbar">
			{isMail && (
				<button
					type="button"
					className="icon-button menu-button"
					aria-label="Main menu"
					aria-expanded={navOpen}
					aria-controls="mail-nav"
					onClick={onToggleNav}
				>
					<Icon name="menu" />
				</button>
			)}
			<Link to={INBOX_PATH} className="brand" aria-label="Soldock Mail, go to the inbox">
				<span className="brand-mark" aria-hidden="true">
					<Icon name="mail" size={18} />
				</span>
				<span className="brand-name">Soldock</span>
			</Link>
			<SearchBox route={route} />
			<AccountMenu />
		</header>
	);
}

function SearchBox({ route }: { route: Route }) {
	const current = route.page === "mail" && route.view.kind === "search" ? route.view.query : "";
	const [value, setValue] = useState(current);

	useOnChange(current, () => setValue(current));

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const query = value.trim();
		navigate(query ? viewPath({ kind: "search", query }) : INBOX_PATH);
		(document.activeElement as HTMLElement | null)?.blur();
	}

	return (
		<search className="search">
			<form onSubmit={submit}>
				<label htmlFor={SEARCH_INPUT_ID} className="visually-hidden">
					Search mail
				</label>
				<Icon name="search" className="search-icon" />
				<input
					id={SEARCH_INPUT_ID}
					className="search-input"
					type="search"
					placeholder="Search mail"
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
