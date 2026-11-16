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
	/** A search from a shared drive stays in that drive. Drive only. */
	sharedDrive?: { id: string; name: string | null } | null;
}

/** The search box in the header of Mail and of Drive. */
export function SearchBox({ product, query, mailboxId = null, sharedDrive = null }: SearchBoxProps) {
	const [value, setValue] = useState(query);
	const label =
		product === "mail"
			? "Search mail"
			: sharedDrive
				? `Search in ${sharedDrive.name ?? "this drive"}`
				: "Search in Drive";

	useOnChange(query, () => setValue(query));

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const next = value.trim();
		if (product === "drive") {
			// The id of a shared drive stays in the path. An empty query goes back to the root of the drive.
			const space = sharedDrive ? { spaceId: sharedDrive.id } : {};
			navigate(
				drivePath(
					next
						? { kind: "search", query: next, ...space }
						: { kind: "folder", spaceId: sharedDrive?.id ?? null, folderId: null },
				),
			);
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
