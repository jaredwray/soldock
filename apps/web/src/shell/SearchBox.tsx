import { type FormEvent, useState } from "react";
import { Icon } from "../lib/icons.tsx";
import { navigate } from "../lib/router.tsx";
import { useOnChange } from "../lib/useOnChange.ts";
import { drivePath, viewPath } from "../routes.ts";
import { SEARCH_INPUT_ID } from "./nav.ts";

interface SearchBoxProps {
	/** Mail finds conversations. Drive finds items. */
	product: "mail" | "drive";
	/** The query of the search results on screen, or an empty string. */
	query: string;
	/** A search from a team mailbox or an agent mailbox stays in that mailbox. Mail only. */
	mailboxId?: string | null;
}

/** The search box in the header of Mail and of Drive. */
export function SearchBox({ product, query, mailboxId = null }: SearchBoxProps) {
	const [value, setValue] = useState(query);
	const label = product === "drive" ? "Search in Drive" : "Search mail";

	useOnChange(query, () => setValue(query));

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const next = value.trim();
		if (product === "drive") {
			navigate(drivePath(next ? { kind: "search", query: next } : { kind: "folder", spaceId: null, folderId: null }));
		} else {
			navigate(viewPath(next ? { kind: "search", query: next } : { kind: "system", view: "inbox" }, mailboxId));
		}
		(document.activeElement as HTMLElement | null)?.blur();
	}

	return (
		<search className="search">
			<form onSubmit={submit}>
				<label htmlFor={SEARCH_INPUT_ID} className="visually-hidden">
					{label}
				</label>
				<Icon name="search" size={16} className="search-icon" />
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
				{/* The key that moves the focus to the box. Mail has this shortcut. */}
				{product === "mail" && (
					<span className="search-key" aria-hidden="true">
						/
					</span>
				)}
			</form>
		</search>
	);
}
