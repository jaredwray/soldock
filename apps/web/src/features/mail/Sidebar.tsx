import type { Label, Mailbox } from "@soldock/contracts";
import { useEffect, useRef } from "react";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { type MailView, viewPath } from "../../routes.ts";
import { MAIL_NAV_ID, MENU_BUTTON_ID } from "../../shell/TopBar.tsx";
import { labelRows, SYSTEM_NAV } from "./views.ts";

interface SidebarProps {
	/** The team mailbox or the agent mailbox of the views, or null for the own mailbox. */
	mailboxId: string | null;
	/**
	 * The mailboxes that the person can use. The switcher shows when a team mailbox or an agent mailbox
	 * is in the list. Only owners and admins get agent mailboxes.
	 */
	mailboxes: readonly Mailbox[] | null;
	/** True in the mailbox of an agent: no compose button and no label changes. */
	readOnly: boolean;
	view: MailView;
	labels: Label[] | null;
	labelsError: string | null;
	open: boolean;
	onCompose: () => void;
	onNewLabel: () => void;
	onDeleteLabel: (label: Label) => void;
	onClose: () => void;
}

/** The left navigation. Under 768px it is a drawer that the menu button in the top bar opens. */
export function Sidebar({
	mailboxId,
	mailboxes,
	readOnly,
	view,
	labels,
	labelsError,
	open,
	onCompose,
	onNewLabel,
	onDeleteLabel,
	onClose,
}: SidebarProps) {
	const byId = new Map((labels ?? []).map((label) => [label.id, label]));
	const rows = labelRows(labels ?? []);
	const navRef = useRef<HTMLElement>(null);
	const wasOpen = useRef(open);
	const ownAndTeam = (mailboxes ?? []).filter((mailbox) => mailbox.kind !== "agent");
	const agentMailboxes = (mailboxes ?? []).filter((mailbox) => mailbox.kind === "agent");
	// A deep link can open a team mailbox before the list loads, or after the access ended.
	const showMailboxes = ownAndTeam.some((m) => m.kind === "team") || agentMailboxes.length > 0 || mailboxId !== null;

	// The drawer under 768px: when it opens, the focus goes to its first item. When it closes, the
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
				{!readOnly && (
					<button type="button" className="compose-button" onClick={onCompose}>
						<Icon name="pencil" />
						Compose
					</button>
				)}
				{showMailboxes && (
					<>
						<div className={readOnly ? "nav-section" : "nav-section nav-section-first"}>
							<h2 className="nav-heading">Mailboxes</h2>
						</div>
						<ul className="nav-list nav-mailboxes">
							{ownAndTeam.map((mailbox) => (
								<MailboxLink key={mailbox.id} mailbox={mailbox} current={mailboxId} />
							))}
						</ul>
						{agentMailboxes.length > 0 && (
							<>
								<div className="nav-section">
									<h2 className="nav-heading">Agent mailboxes</h2>
								</div>
								<ul className="nav-list nav-mailboxes" aria-label="Agent mailboxes, read only">
									{agentMailboxes.map((mailbox) => (
										<MailboxLink key={mailbox.id} mailbox={mailbox} current={mailboxId} />
									))}
								</ul>
							</>
						)}
						<div className="nav-section">
							<h2 className="nav-heading">Folders</h2>
						</div>
					</>
				)}
				<ul className="nav-list">
					{SYSTEM_NAV.map((item) => {
						const active = view.kind === "system" && view.view === item.view;
						const unread = item.countLabel ? (byId.get(item.countLabel)?.threads_unread ?? 0) : 0;
						return (
							<li key={item.view}>
								<Link
									to={viewPath({ kind: "system", view: item.view }, mailboxId)}
									className={active ? "nav-item nav-item-active" : "nav-item"}
									aria-current={active ? "page" : undefined}
								>
									<Icon name={item.icon} />
									<span className="nav-name">{item.title}</span>
									{unread > 0 && (
										<span className="nav-count">
											{unread}
											<span className="visually-hidden"> unread</span>
										</span>
									)}
								</Link>
							</li>
						);
					})}
				</ul>
				<div className="nav-section">
					<h2 className="nav-heading">Labels</h2>
					{!readOnly && (
						<button
							type="button"
							className="icon-button icon-button-small"
							aria-label="New label"
							title="New label"
							onClick={onNewLabel}
						>
							<Icon name="plus" size={18} />
						</button>
					)}
				</div>
				{labelsError && labels === null && <p className="nav-error">Labels are not available.</p>}
				<ul className="nav-list">
					{rows.map((row) => {
						const indent = { paddingInlineStart: `${16 + row.depth * 16}px` };
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
						const active = view.kind === "label" && view.labelId === label.id;
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
								{!readOnly && (
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
				<p className="nav-hint">
					Press <kbd>?</kbd> for keyboard shortcuts.
				</p>
			</nav>
		</>
	);
}

/** One row of the mailbox switcher. It opens the inbox of the mailbox. */
function MailboxLink({ mailbox, current }: { mailbox: Mailbox; current: string | null }) {
	const id = mailbox.kind === "personal" ? null : mailbox.id;
	const active = id === current;
	const icon = mailbox.kind === "team" ? "team" : mailbox.kind === "agent" ? "bot" : "mail";
	return (
		<li>
			<Link
				to={viewPath({ kind: "system", view: "inbox" }, id)}
				className={active ? "nav-item nav-item-active" : "nav-item"}
				aria-current={active ? "true" : undefined}
				title={mailbox.address}
			>
				<Icon name={icon} />
				<span className="nav-name">
					{mailbox.kind === "personal" ? "My mailbox" : mailbox.display_name}
					<span className="visually-hidden">{`, ${mailbox.address}`}</span>
				</span>
			</Link>
		</li>
	);
}
