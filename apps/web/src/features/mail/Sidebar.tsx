import type { Label, Mailbox } from "@asterra/contracts";
import { Fragment, type ReactNode, useEffect, useId, useRef } from "react";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { type MailView, screenerPath, viewPath } from "../../routes.ts";
import { MAIL_NAV_ID, MENU_BUTTON_ID } from "../../shell/nav.ts";
import { SidebarHeader } from "../../shell/SidebarHeader.tsx";
import { useLabels } from "./data.ts";
import { isExpanded, type MailboxEntry, mailboxNav } from "./mailboxNav.ts";
import { labelRows, navCount, SYSTEM_NAV } from "./views.ts";

interface SidebarProps {
	/** The team mailbox or the agent mailbox of the views, or null for the own mailbox. */
	mailboxId: string | null;
	/** The name of the open mailbox, for a row before the list of mailboxes loads. Null for the own mailbox. */
	mailboxName: string | null;
	/** The address of the open mailbox, for the line under the name of the sidebar. */
	address: string;
	/**
	 * The mailboxes that the person can use. The sidebar shows a row for each mailbox when a team mailbox
	 * or an agent mailbox is in the list. Only owners and admins get agent mailboxes.
	 */
	mailboxes: readonly Mailbox[] | null;
	/** The mailboxes that the person expanded (true) or collapsed (false), by `mailboxKey`. */
	expanded: Readonly<Record<string, boolean>>;
	/** Expands or collapses a mailbox. Null goes back to the default: only the open mailbox is expanded. */
	onSetExpanded: (key: string, expanded: boolean | null) => void;
	/** False when the person cannot change the mailbox: no label changes. */
	canModify: boolean;
	/** False when the person cannot send from the mailbox: no compose button. */
	canSend: boolean;
	/** The view that shows, or null in the settings view and the Screener view of the mailbox. */
	view: MailView | null;
	/**
	 * The Screener item of the open mailbox: the senders that wait, and true when the Screener view shows.
	 * Null when the sidebar does not show the item.
	 */
	screener: { pending: number; active: boolean } | null;
	labels: Label[] | null;
	labelsError: string | null;
	open: boolean;
	onCompose: () => void;
	onNewLabel: () => void;
	/** Opens the auto-label settings of the open mailbox. */
	onAutoLabels: () => void;
	onDeleteLabel: (label: Label) => void;
	onClose: () => void;
}

/** The sidebar of Mail. At 900px and below it is part of the drawer that the menu button opens. */
export function Sidebar({
	mailboxId,
	mailboxName,
	address,
	mailboxes,
	expanded,
	onSetExpanded,
	canModify,
	canSend,
	view,
	screener,
	labels,
	labelsError,
	open,
	onCompose,
	onNewLabel,
	onAutoLabels,
	onDeleteLabel,
	onClose,
}: SidebarProps) {
	const navRef = useRef<HTMLElement>(null);
	const wasOpen = useRef(open);
	const entries = mailboxNav(mailboxes, mailboxId, mailboxName);

	// The drawer at 900px and below: when it opens, the focus goes to its first item. When it closes, the
	// focus goes back to the menu button, if the focus was in the drawer.
	useEffect(() => {
		const nav = navRef.current;
		if (!nav || open === wasOpen.current) return;
		wasOpen.current = open;
		if (open) {
			nav.querySelector<HTMLElement>("a[href], button")?.focus();
		} else if (nav.contains(document.activeElement) || document.activeElement === document.body) {
			document.getElementById(MENU_BUTTON_ID)?.focus();
		}
	}, [open]);

	// The folders and labels of the open mailbox. Only the open mailbox can add or delete a label.
	const currentContents = (nested: boolean) => (
		<MailboxContents
			mailboxId={mailboxId}
			view={view}
			screener={screener}
			labels={labels}
			labelsError={labelsError}
			nested={nested}
			editable={canModify}
			onNewLabel={onNewLabel}
			onAutoLabels={onAutoLabels}
			onDeleteLabel={onDeleteLabel}
		/>
	);

	return (
		<>
			{open && (
				<button type="button" className="nav-backdrop" aria-label="Close the menu" tabIndex={-1} onClick={onClose} />
			)}
			<nav
				id={MAIL_NAV_ID}
				ref={navRef}
				className={open ? "sidebar sidebar-open" : "sidebar"}
				aria-label="Mailboxes, folders and labels"
			>
				<SidebarHeader title="Mail" subtitle={address} />
				{canSend && (
					<button type="button" className="compose-button" onClick={onCompose}>
						<Icon name="pencil" size={16} />
						Compose
					</button>
				)}
				{entries ? (
					<ul className="nav-list nav-tree" aria-label="Mailboxes">
						{entries.map((entry) => {
							const current = entry.id === mailboxId;
							const shown = isExpanded(entry, mailboxId, expanded);
							return (
								<MailboxNode
									key={entry.key}
									entry={entry}
									current={current}
									expanded={shown}
									onToggle={() => onSetExpanded(entry.key, !shown)}
									onOpen={() => onSetExpanded(entry.key, null)}
								>
									{shown && (current ? currentContents(true) : <OtherMailboxContents mailboxId={entry.id} />)}
								</MailboxNode>
							);
						})}
					</ul>
				) : (
					currentContents(false)
				)}
				<p className="nav-hint">
					Press <kbd>?</kbd> for keyboard shortcuts.
				</p>
			</nav>
		</>
	);
}

/**
 * One mailbox row. The name opens the inbox of the mailbox. The chevron on the right expands or
 * collapses the folders and labels of the mailbox.
 */
function MailboxNode({
	entry,
	current,
	expanded,
	onToggle,
	onOpen,
	children,
}: {
	entry: MailboxEntry;
	current: boolean;
	expanded: boolean;
	onToggle: () => void;
	onOpen: () => void;
	children: ReactNode;
}) {
	const groupId = useId();
	// An agent mailbox of a service account gets the settings icon, as in Admin › Members.
	const icon = entry.kind === "personal" ? "mail" : entry.kind === "team" ? "team" : entry.service ? "settings" : "bot";
	// A screen reader also reads the address, and "read only" for the mailbox of an agent.
	const extra = [entry.address, entry.kind === "agent" ? "read only" : null].filter(Boolean).join(", ");
	return (
		<li className="nav-tree-node">
			<div className="nav-mailbox-row">
				<Link
					to={viewPath({ kind: "system", view: "inbox" }, entry.id)}
					className={current ? "nav-item nav-mailbox nav-mailbox-current" : "nav-item nav-mailbox"}
					aria-current={current ? "true" : undefined}
					title={entry.address ?? undefined}
					onClick={onOpen}
				>
					<Icon name={icon} />
					<span className="nav-name">
						{entry.name}
						{extra && <span className="visually-hidden">{`, ${extra}`}</span>}
					</span>
				</Link>
				<button
					type="button"
					className="icon-button icon-button-small nav-mailbox-toggle"
					aria-label={`Folders and labels of ${entry.name}`}
					title={expanded ? "Hide folders and labels" : "Show folders and labels"}
					aria-expanded={expanded}
					aria-controls={groupId}
					onClick={onToggle}
				>
					<Icon name="chevronDown" size={16} className={expanded ? "nav-chevron nav-chevron-open" : "nav-chevron"} />
				</button>
			</div>
			<div id={groupId} className="nav-tree-children" hidden={!expanded}>
				{children}
			</div>
		</li>
	);
}

/**
 * The folders and labels of an expanded mailbox that is not open. The labels load when the mailbox
 * expands. The links open the mailbox. Label changes are only in the open mailbox.
 */
function OtherMailboxContents({ mailboxId }: { mailboxId: string | null }) {
	const { labels, error } = useLabels(mailboxId);
	return (
		<MailboxContents mailboxId={mailboxId} view={null} labels={labels} labelsError={error} nested editable={false} />
	);
}

/** The system folders and the labels of one mailbox. */
function MailboxContents({
	mailboxId,
	view,
	screener = null,
	labels,
	labelsError,
	nested,
	editable,
	onNewLabel,
	onAutoLabels,
	onDeleteLabel,
}: {
	mailboxId: string | null;
	/** The view that shows, or null when the mailbox is not open. */
	view: MailView | null;
	/** The Screener item, after the inbox. Only the open mailbox shows it. */
	screener?: { pending: number; active: boolean } | null;
	labels: Label[] | null;
	labelsError: string | null;
	/** True under a mailbox row: the heading of the labels is one level lower. */
	nested: boolean;
	/** True when the person can add and delete labels here. */
	editable: boolean;
	onNewLabel?: () => void;
	onAutoLabels?: () => void;
	onDeleteLabel?: (label: Label) => void;
}) {
	const byId = new Map((labels ?? []).map((label) => [label.id, label]));
	const rows = labelRows(labels ?? []);
	const Heading = nested ? "h3" : "h2";
	return (
		<>
			<ul className="nav-list">
				{SYSTEM_NAV.map((item) => {
					const active = view?.kind === "system" && view.view === item.view;
					const count = navCount(item, byId);
					return (
						<Fragment key={item.view}>
							<li>
								<Link
									to={viewPath({ kind: "system", view: item.view }, mailboxId)}
									className={active ? "nav-item nav-item-active" : "nav-item"}
									aria-current={active ? "page" : undefined}
								>
									<Icon name={item.icon} />
									<span className="nav-name">{item.title}</span>
									{count > 0 && (
										<span className="nav-count">
											{count}
											<span className="visually-hidden">{item.count?.of === "total" ? " to answer" : " unread"}</span>
										</span>
									)}
								</Link>
							</li>
							{/* The Screener of the open mailbox comes after its inbox. */}
							{item.view === "inbox" && screener && (
								<li>
									<Link
										to={screenerPath(mailboxId)}
										className={screener.active ? "nav-item nav-item-active" : "nav-item"}
										aria-current={screener.active ? "page" : undefined}
									>
										<Icon name="shield" />
										<span className="nav-name">Screener</span>
										{screener.pending > 0 && (
											<span className="nav-count">
												{screener.pending}
												<span className="visually-hidden">
													{screener.pending === 1 ? " sender waits" : " senders wait"}
												</span>
											</span>
										)}
									</Link>
								</li>
							)}
						</Fragment>
					);
				})}
			</ul>
			<div className={nested ? "nav-section nav-section-nested" : "nav-section"}>
				<Heading className="nav-heading">Labels</Heading>
				{editable && onAutoLabels && (
					<button
						type="button"
						className="icon-button icon-button-small nav-heading-action"
						aria-label="Auto labels"
						title="Auto labels"
						onClick={onAutoLabels}
					>
						<Icon name="sparks" size={15} />
					</button>
				)}
				{editable && onNewLabel && (
					<button
						type="button"
						className="icon-button icon-button-small"
						aria-label="New label"
						title="New label"
						onClick={onNewLabel}
					>
						<Icon name="plus" size={15} />
					</button>
				)}
			</div>
			{labelsError && labels === null && <p className="nav-error">Labels are not available.</p>}
			<ul className="nav-list">
				{rows.map((row) => {
					// A nested label is 16px more to the right for each level. The 9px is the padding of a row.
					const indent = row.depth > 0 ? { paddingInlineStart: `${9 + row.depth * 16}px` } : undefined;
					const label = row.label;
					if (!label) {
						// A group row: a parent path that is not a label. It is text, not a link.
						return (
							<li key={row.key} className="nav-label-row">
								<span className="nav-item nav-group" style={indent}>
									<Icon name="folder" />
									<span className="nav-name">
										<span aria-hidden="true">{row.name}</span>
										<span className="visually-hidden">{`${row.parent}${row.name}`}</span>
									</span>
								</span>
							</li>
						);
					}
					const active = view?.kind === "label" && view.labelId === label.id;
					return (
						<li key={row.key} className="nav-label-row">
							<Link
								to={viewPath({ kind: "label", labelId: label.id }, mailboxId)}
								className={active ? "nav-item nav-item-active" : "nav-item"}
								aria-current={active ? "page" : undefined}
								style={indent}
								title={label.name}
							>
								<Icon name="tag" />
								{row.parent ? (
									// A screen reader reads the full path, for example Clients/Northwind.
									<span className="nav-name">
										<span aria-hidden="true">{row.name}</span>
										<span className="visually-hidden">{label.name}</span>
									</span>
								) : (
									<span className="nav-name">{row.name}</span>
								)}
								{label.threads_unread > 0 && (
									<span className="nav-count">
										{label.threads_unread}
										<span className="visually-hidden"> unread</span>
									</span>
								)}
							</Link>
							{editable && onDeleteLabel && (
								<button
									type="button"
									className="icon-button icon-button-small nav-label-delete"
									aria-label={`Delete label ${label.name}`}
									title="Delete label"
									onClick={() => onDeleteLabel(label)}
								>
									<Icon name="trash" size={16} />
								</button>
							)}
						</li>
					);
				})}
				{labels !== null && rows.length === 0 && <li className="nav-empty">No labels yet.</li>}
			</ul>
		</>
	);
}
