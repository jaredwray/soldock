import { EmailAddress, type ScreenerSender } from "@asterra/contracts";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { plural, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { type ScreenerTab, screenerPath, threadPath, viewPath } from "../../routes.ts";
import { SearchBox } from "../../shell/SearchBox.tsx";
import { mailboxInput } from "./mailbox.tsx";
import type { MailboxRights } from "./mailboxNav.ts";
import { senderTitle } from "./screener.ts";

export interface ScreenerProps {
	/** The team mailbox or the agent mailbox, or null for the own mailbox of the person. */
	mailboxId: string | null;
	tab: ScreenerTab;
	title: string;
	/** True when the Screener holds new mail in this mailbox now. */
	enabled: boolean;
	rights: MailboxRights;
	/** Grows when the mailbox changes, so the list loads again. */
	refreshKey: number;
	/** Called after a decision, so the counts, the labels and the lists load again. */
	onChanged: () => void;
}

/**
 * The Screener of the open mailbox (`/mail/screener`, or under the path of a team or agent mailbox). The
 * Waiting tab lists the senders that wait, with their newest message. The History tab lists the decisions.
 * A person with mail.modify screens a sender in or out. The sender is never told.
 */
export function Screener(props: ScreenerProps) {
	const { mailboxId, tab } = props;
	const inbox = viewPath({ kind: "system", view: "inbox" }, mailboxId);
	return (
		<main id="main" className="mail-main" tabIndex={-1}>
			<div className="toolbar">
				<Link to={inbox} className="icon-button" aria-label="Back to the inbox" title="Back to the inbox">
					<Icon name="back" />
				</Link>
				<div className="page-title">
					<Icon name="shield" />
					<h1 className="toolbar-title">{props.title}</h1>
				</div>
				<span className="toolbar-spacer" />
				<SearchBox product="mail" query="" mailboxId={mailboxId} />
			</div>
			<div className="mail-scroll">
				<div className="page screener">
					<p className="panel-intro">
						The first mail from a new sender outside the organization waits here. Screen the sender in to get their mail
						in the inbox. Screen the sender out to not see their mail. The sender is not told.
					</p>
					{!props.enabled && (
						<p className="notice notice-warning" role="status">
							<Icon name="info" size={16} className="notice-icon" />
							<span>The Screener is off in this mailbox. New mail goes to the inbox.</span>
						</p>
					)}
					{!props.rights.modify && (
						<p className="field-hint screener-line">
							{mailboxId?.startsWith("prn_")
								? "You can only read the mailbox of an agent."
								: "Your membership does not let you screen senders in this mailbox."}
						</p>
					)}
					<nav className="screener-tabs" aria-label="Screener views">
						<Link
							to={screenerPath(mailboxId, "waiting")}
							className={tab === "waiting" ? "segment segment-active" : "segment"}
							aria-current={tab === "waiting" ? "page" : undefined}
						>
							Waiting
						</Link>
						<Link
							to={screenerPath(mailboxId, "history")}
							className={tab === "history" ? "segment segment-active" : "segment"}
							aria-current={tab === "history" ? "page" : undefined}
						>
							History
						</Link>
					</nav>
					{tab === "waiting" ? <SenderList {...props} status="pending" /> : <History {...props} />}
				</div>
			</div>
		</main>
	);
}

/** The decisions: the senders that a person screened out (the default) or in, and a form for a new sender. */
function History(props: ScreenerProps) {
	const [status, setStatus] = useState<"out" | "in">("out");
	const name = useId();
	return (
		<>
			<fieldset className="segmented">
				<legend className="visually-hidden">Decisions</legend>
				{(["out", "in"] as const).map((value) => (
					<label key={value} className={status === value ? "segment segment-active" : "segment"}>
						<input
							type="radio"
							name={name}
							value={value}
							checked={status === value}
							onChange={() => setStatus(value)}
						/>
						{value === "out" ? "Screened out" : "Screened in"}
					</label>
				))}
			</fieldset>
			<SenderList key={status} {...props} status={status} />
			{props.rights.modify && <ScreenOutForm {...props} />}
		</>
	);
}

/** One page of senders and the cursor of the next page. */
interface Page {
	senders: ScreenerSender[];
	next: string | null;
}

function SenderList(props: ScreenerProps & { status: "pending" | "in" | "out" }) {
	const { mailboxId, status, refreshKey, rights, onChanged } = props;
	const toast = useToast();
	const [page, setPage] = useState<Page | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [more, setMore] = useState(false);
	const listRef = useRef<HTMLUListElement>(null);
	// The row whose buttons get the focus after a decision removes a row: the next row, or the one before.
	const [focusRow, setFocusRow] = useState<number | null>(null);

	const load = useCallback(async () => {
		setError(null);
		try {
			const result = await api.call("mail.list_screener", { ...mailboxInput(mailboxId), status });
			setPage({ senders: result.senders, next: result.next_cursor });
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [mailboxId, status]);

	useEffect(() => {
		void load();
	}, [load]);
	useOnChange(refreshKey, () => void load());

	useEffect(() => {
		if (focusRow === null) return;
		const rows = listRef.current?.querySelectorAll<HTMLElement>(".screener-row");
		const target = rows?.[Math.min(focusRow, rows.length - 1)];
		(target?.querySelector<HTMLElement>("button, a[href]") ?? listRef.current)?.focus();
		setFocusRow(null);
	}, [focusRow]);

	async function loadMore() {
		if (!page?.next) return;
		setMore(true);
		setError(null);
		try {
			const result = await api.call("mail.list_screener", { ...mailboxInput(mailboxId), status, cursor: page.next });
			setPage({ senders: [...page.senders, ...result.senders], next: result.next_cursor });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setMore(false);
		}
	}

	async function decide(sender: ScreenerSender, decision: "in" | "out") {
		setBusy(sender.address);
		setError(null);
		try {
			await api.call("mail.screen_sender", { ...mailboxInput(mailboxId), address: sender.address, decision });
			const index = page?.senders.findIndex((item) => item.address === sender.address) ?? -1;
			setPage((current) =>
				current ? { ...current, senders: current.senders.filter((item) => item.address !== sender.address) } : current,
			);
			setFocusRow(Math.max(index, 0));
			toast({
				message:
					decision === "in"
						? `Mail from ${sender.address} now comes to the inbox.`
						: `You will not see mail from ${sender.address}. The sender is not told.`,
			});
			onChanged();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(null);
		}
	}

	// The messages of a sender open in the search of held mail, in the pane of the views.
	const heldQuery = status === "out" ? "in:screened_out" : "in:screener";
	const empty =
		status === "pending"
			? "No sender waits."
			: status === "out"
				? "You screened out no sender."
				: "You screened in no sender.";

	return (
		<section className="panel" aria-label={status === "pending" ? "Senders that wait" : "Decisions"}>
			{page === null && !error && <p className="panel-card panel-empty">Loading…</p>}
			{page === null && error && (
				<div role="alert">
					<p className="form-error">{error}</p>
					<button type="button" className="button button-small" onClick={() => void load()}>
						Try again
					</button>
				</div>
			)}
			{page && page.senders.length === 0 && <p className="panel-card panel-empty">{empty}</p>}
			{page && page.senders.length > 0 && (
				<ul ref={listRef} className="panel-card screener-list" tabIndex={-1}>
					{page.senders.map((sender) => (
						<li key={sender.address} className="screener-row">
							<div className="screener-sender">
								<span className="screener-name">{sender.name?.trim() || sender.address}</span>
								{sender.name?.trim() && <span className="row-note">{sender.address}</span>}
							</div>
							{sender.latest && (
								<p className="screener-preview screener-line">
									<span className="screener-subject">{sender.latest.subject || "(no subject)"}</span>
									{sender.latest.snippet && <span className="row-note"> – {sender.latest.snippet}</span>}
								</p>
							)}
							<p className="row-note screener-line">
								{status === "in" || status === "out"
									? decidedText(sender)
									: `${plural(sender.messages_held, "message")}${
											sender.latest ? `, newest ${shortDate(sender.latest.received_at)}` : ""
										}`}
								{status === "out" && sender.messages_held > 0 && `, ${plural(sender.messages_held, "hidden message")}`}
							</p>
							<div className="screener-actions">
								{sender.latest && (
									<Link
										to={threadPath({ kind: "search", query: heldQuery }, sender.latest.thread_id, mailboxId)}
										className="button button-small"
									>
										Open the newest message
									</Link>
								)}
								{rights.modify && status !== "in" && (
									<button
										type="button"
										className="button button-primary button-small"
										disabled={busy !== null}
										aria-label={`Screen in ${senderTitle(sender)}`}
										onClick={() => void decide(sender, "in")}
									>
										Screen in
									</button>
								)}
								{rights.modify && status !== "out" && (
									<button
										type="button"
										className="button button-small"
										disabled={busy !== null}
										aria-label={`Screen out ${senderTitle(sender)}`}
										onClick={() => void decide(sender, "out")}
									>
										Screen out
									</button>
								)}
							</div>
						</li>
					))}
				</ul>
			)}
			{page && error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			{page?.next && (
				<button type="button" className="button button-small" disabled={more} onClick={() => void loadMore()}>
					{more ? "Loading…" : "Load more"}
				</button>
			)}
		</section>
	);
}

/** Who decided and when, for a row of the history. */
function decidedText(sender: ScreenerSender): string {
	const who = sender.decided_by?.display_name;
	const when = sender.decided_at ? shortDate(sender.decided_at) : null;
	const verb = sender.status === "in" ? "Screened in" : "Screened out";
	return `${[verb, who ? `by ${who}` : null].filter(Boolean).join(" ")}${when ? `, ${when}` : ""}`;
}

/** Screens out a sender that did not write yet, or whose mail is already in the views. */
function ScreenOutForm({ mailboxId, onChanged }: ScreenerProps) {
	const toast = useToast();
	const ids = { field: useId(), hint: useId() };
	const [address, setAddress] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const parsed = EmailAddress.safeParse(address.trim());
		if (!parsed.success) return setError("Enter an email address, such as name@example.com.");
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("mail.screen_sender", {
				...mailboxInput(mailboxId),
				address: parsed.data,
				decision: "out",
			});
			setAddress("");
			toast({ message: `You will not see new mail from ${result.address}. The sender is not told.` });
			onChanged();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="panel-card screener-form" onSubmit={submit} noValidate>
			<label htmlFor={ids.field} className="field-label">
				Screen out a sender
			</label>
			<p id={ids.hint} className="field-hint screener-line">
				New mail from this address stays out of each view. Mail that is in a view already stays there.
			</p>
			<div className="screener-form-row">
				<input
					id={ids.field}
					className="input"
					type="email"
					autoComplete="off"
					value={address}
					onChange={(event) => setAddress(event.target.value)}
					aria-describedby={ids.hint}
					aria-invalid={error ? true : undefined}
					disabled={busy}
				/>
				<button type="submit" className="button button-small" disabled={busy || address.trim() === ""}>
					{busy ? "Saving…" : "Screen out"}
				</button>
			</div>
			{error && (
				<p className="form-error screener-line" role="alert">
					{error}
				</p>
			)}
		</form>
	);
}
