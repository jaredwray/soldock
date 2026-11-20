import type { ChatRoom, ChatSearchResult } from "@asterra/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fullDate, plural, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link, navigate } from "../../lib/router.tsx";
import { Select, type SelectOption } from "../../lib/Select.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { chatPath, chatSearchPath } from "../../routes.ts";
import { SEARCH_INPUT_ID } from "../../shell/nav.ts";
import { PageHeader } from "../../shell/PageHeader.tsx";
import { useSession } from "../auth/session.tsx";
import { draftStorage } from "./drafts.ts";
import { roomTitle } from "./model.ts";
import { clearSearches, recentSearches, rememberSearch, resultParts } from "./searchModel.ts";

/** The results of one page of the view. */
const PAGE = 20;
/** The most pages without a result that one read asks for. A page of the server can have no result and a next page. */
const EMPTY_PAGES = 5;

type Sort = "rank" | "time";

const SORT_OPTIONS: readonly SelectOption<Sort>[] = [
	{ value: "rank", label: "Best match" },
	{ value: "time", label: "Newest" },
];

type ListState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "ready"; results: ChatSearchResult[]; nextCursor: string | null }
	| { status: "error"; error: string };

interface SearchInput {
	query: string;
	roomId: string | null;
	sort: Sort;
}

/**
 * One page of `chat.search_messages`. The room of each hit makes its checks again, so a page can have
 * fewer results than the server found, also none. The read then asks for the next page, at most
 * `EMPTY_PAGES` times.
 */
async function readResults(input: SearchInput, cursor: string | null) {
	const call = (next: string | null) =>
		api.call("chat.search_messages", {
			query: input.query,
			sort: input.sort,
			limit: PAGE,
			...(input.roomId === null ? {} : { room_id: input.roomId }),
			...(next === null ? {} : { cursor: next }),
		});
	let page = await call(cursor);
	for (let empty = 0; page.results.length === 0 && page.next_cursor !== null && empty < EMPTY_PAGES; empty++) {
		page = await call(page.next_cursor);
	}
	return page;
}

/** The key of a result in the view: the room and the message. */
function resultKey(result: ChatSearchResult): string {
	return `${result.room.id}/${result.message.id}`;
}

/** The path of the message of a result: the message in its room, or the reply in its thread. */
function resultPath(result: ChatSearchResult): string {
	return result.parent_seq === null
		? chatPath(result.room.id, result.message.seq)
		: chatPath(result.room.id, result.parent_seq, result.message.seq);
}

export interface SearchViewProps {
	/** The query of the path. An empty query shows the box and the recent searches. */
	query: string;
	/** The room of a search in one room, or null for a search in each room of the person. */
	roomId: string | null;
	/** The joined rooms of the person, for the name of the room of the search. */
	rooms: readonly ChatRoom[];
}

/**
 * The Search view of Chat: a box for the query, and the messages that `chat.search_messages` finds, each
 * with its room, its author and the found words marked. The path has the query, so a search has a link, and
 * the back button of the browser goes to the search before. The browser keeps the recent searches of the
 * person.
 */
export function SearchView({ query, roomId, rooms }: SearchViewProps) {
	const ownId = useSession().whoami.principal.id;
	const [value, setValue] = useState(query);
	const [sort, setSort] = useState<Sort>("rank");
	const [state, setState] = useState<ListState>({ status: "idle" });
	const [loadingMore, setLoadingMore] = useState(false);
	/** The reason of a "Show more" that failed. The list stays. */
	const [moreError, setMoreError] = useState<string | null>(null);
	const [recent, setRecent] = useState(() => recentSearches(draftStorage(), ownId));
	/** The number of the newest read. An older answer does not replace a newer one. */
	const reads = useRef(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const helpId = useId();
	const room = roomId === null ? null : (rooms.find((listed) => listed.id === roomId) ?? null);

	useOnChange(query, () => setValue(query));

	useEffect(() => {
		document.title = query === "" ? "Search – Chat – Asterra" : `${query} – Search – Asterra`;
	}, [query]);

	// The view opens for a search: the box has the focus.
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		const read = ++reads.current;
		setMoreError(null);
		if (query === "") {
			setState({ status: "idle" });
			return;
		}
		setState({ status: "loading" });
		readResults({ query, roomId, sort }, null)
			.then((page) => {
				if (read !== reads.current) return;
				setState({ status: "ready", results: page.results, nextCursor: page.next_cursor });
				rememberSearch(draftStorage(), ownId, query);
				setRecent(recentSearches(draftStorage(), ownId));
			})
			.catch((error: unknown) => {
				if (read === reads.current) setState({ status: "error", error: errorMessage(error) });
			});
	}, [query, roomId, sort, ownId]);

	async function showMore() {
		if (state.status !== "ready" || state.nextCursor === null || loadingMore) return;
		setLoadingMore(true);
		setMoreError(null);
		const read = reads.current;
		try {
			const page = await readResults({ query, roomId, sort }, state.nextCursor);
			if (read !== reads.current) return;
			setState((current) => {
				if (current.status !== "ready") return current;
				// The pages have no snapshot: a message can come two times.
				const seen = new Set(current.results.map(resultKey));
				const added = page.results.filter((result) => !seen.has(resultKey(result)));
				return { status: "ready", results: [...current.results, ...added], nextCursor: page.next_cursor };
			});
		} catch (error) {
			if (read === reads.current) setMoreError(errorMessage(error));
		} finally {
			setLoadingMore(false);
		}
	}

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		navigate(chatSearchPath(value.trim(), roomId));
	}

	const label = roomId === null ? "Search your messages" : `Search in ${room ? roomTitle(room) : "this room"}`;
	return (
		<>
			<PageHeader title="Search" icon="search" />
			<div className="chat-search">
				<search className="chat-search-box">
					<form onSubmit={submit}>
						<label htmlFor={SEARCH_INPUT_ID} className="visually-hidden">
							{label}
						</label>
						<Icon name="search" size={16} className="search-icon" />
						<input
							id={SEARCH_INPUT_ID}
							ref={inputRef}
							className="search-input"
							type="search"
							placeholder={label}
							autoComplete="off"
							spellCheck={false}
							maxLength={500}
							aria-describedby={helpId}
							value={value}
							onChange={(event) => setValue(event.target.value)}
						/>
						<button type="submit" className="button button-primary">
							Search
						</button>
					</form>
				</search>
				{roomId !== null && (
					<p className="chat-search-scope">
						<Icon name={room?.kind === "private" ? "lock" : room?.kind === "dm" ? "chat" : "hash"} size={14} />
						<span>
							In <strong>{room ? roomTitle(room) : "one room"}</strong> only.
						</span>
						<Link to={chatSearchPath(query)}>Search in all your rooms</Link>
					</p>
				)}
				<p id={helpId} className="chat-search-help">
					Use quotes for a phrase and <code className="chat-search-code">*</code> for the start of a word. Filters:{" "}
					<code className="chat-search-code">from:ada</code>{" "}
					{roomId === null && (
						<>
							<code className="chat-search-code">in:general</code>{" "}
						</>
					)}
					<code className="chat-search-code">mentions:me</code> <code className="chat-search-code">has:link</code>{" "}
					<code className="chat-search-code">has:file</code> <code className="chat-search-code">is:thread</code>{" "}
					<code className="chat-search-code">before:2026-10-31</code>{" "}
					<code className="chat-search-code">after:2026-10-01</code>
				</p>

				{state.status === "idle" && recent.length > 0 && (
					<section className="chat-search-recent" aria-label="Recent searches">
						<div className="chat-search-recent-heading">
							<h2>Recent searches</h2>
							<button
								type="button"
								className="button button-small"
								onClick={() => {
									clearSearches(draftStorage(), ownId);
									setRecent([]);
								}}
							>
								Clear
							</button>
						</div>
						<ul>
							{recent.map((text) => (
								<li key={text}>
									<Link to={chatSearchPath(text, roomId)} className="chat-search-recent-item">
										<Icon name="clock" size={14} />
										<span>{text}</span>
									</Link>
								</li>
							))}
						</ul>
					</section>
				)}
				{state.status === "idle" && recent.length === 0 && (
					<div className="chat-empty">
						<p>Search finds the messages and the replies of your rooms and your direct messages.</p>
					</div>
				)}
				{state.status === "loading" && (
					<p className="list-state" role="status">
						<span className="spinner" aria-hidden="true" />
						Searching…
					</p>
				)}
				{state.status === "error" && (
					<p className="list-state" role="alert">
						{state.error}
					</p>
				)}
				{state.status === "ready" && (
					<>
						<div className="chat-search-bar">
							<p role="status">
								{state.results.length === 0
									? "No message matches this search."
									: `${plural(state.results.length, "message")}${state.nextCursor === null ? "" : ", and more"}`}
							</p>
							<Select
								className="label-select"
								label="Order of the results"
								value={sort}
								options={SORT_OPTIONS}
								onChange={setSort}
							/>
						</div>
						<ol className="chat-search-results" aria-label="Search results">
							{state.results.map((result) => (
								<li key={resultKey(result)}>
									<SearchResult result={result} showRoom={roomId === null} />
								</li>
							))}
						</ol>
						{state.nextCursor !== null && (
							<p className="chat-threads-more">
								<button type="button" className="button" disabled={loadingMore} onClick={() => void showMore()}>
									{loadingMore ? "Loading…" : "Show more"}
								</button>
							</p>
						)}
						{moreError && (
							<p className="chat-threads-more-error" role="alert">
								More results did not load. {moreError}
							</p>
						)}
					</>
				)}
			</div>
		</>
	);
}

/** One result: the room, the author, the time, and the text with the found words marked. A click opens the message. */
function SearchResult({ result, showRoom }: { result: ChatSearchResult; showRoom: boolean }) {
	const { message, room } = result;
	const parts = resultParts(message.text, result.highlights);
	return (
		<Link to={resultPath(result)} className="chat-search-result">
			<span className="chat-search-result-meta">
				{showRoom && (
					<span className="chat-search-result-room">
						<Icon name={room.kind === "private" ? "lock" : room.kind === "dm" ? "chat" : "hash"} size={14} />
						{roomTitle(room)}
					</span>
				)}
				<strong>{message.author.display_name}</strong>
				{message.author.kind === "agent" && <span className="kind kind-agent">agent</span>}
				{result.parent_seq !== null && <span>in a thread</span>}
				<time dateTime={message.created_at} title={fullDate(message.created_at)}>
					{shortDate(message.created_at)}
				</time>
			</span>
			<span className="chat-search-result-text">
				{parts.length === 0
					? plural(message.files.length, "file")
					: parts.map((part, index) =>
							// The parts of one text keep their order, so the position is a key that stays.
							// biome-ignore lint/suspicious/noArrayIndexKey: see the line above.
							part.marked ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
						)}
			</span>
			{parts.length > 0 && message.files.length > 0 && (
				<span className="chat-search-result-files">
					<Icon name="paperclip" size={14} />
					{plural(message.files.length, "file")}
				</span>
			)}
		</Link>
	);
}
