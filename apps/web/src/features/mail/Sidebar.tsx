import type { Label } from "@soldock/contracts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { type MailView, viewPath } from "../../routes.ts";
import { SYSTEM_NAV } from "./views.ts";

interface SidebarProps {
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
	const userLabels = (labels ?? [])
		.filter((label) => label.type === "user")
		.sort((a, b) => a.name.localeCompare(b.name));

	return (
		<>
			{open && (
				<button type="button" className="nav-backdrop" aria-label="Close the menu" tabIndex={-1} onClick={onClose} />
			)}
			<nav id="mail-nav" className={open ? "sidebar sidebar-open" : "sidebar"} aria-label="Mail folders and labels">
				<button type="button" className="compose-button" onClick={onCompose}>
					<Icon name="pencil" />
					Compose
				</button>
				<ul className="nav-list">
					{SYSTEM_NAV.map((item) => {
						const active = view.kind === "system" && view.view === item.view;
						const unread = item.countLabel ? (byId.get(item.countLabel)?.threads_unread ?? 0) : 0;
						return (
							<li key={item.view}>
								<Link
									to={viewPath({ kind: "system", view: item.view })}
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
					<button
						type="button"
						className="icon-button icon-button-small"
						aria-label="New label"
						title="New label"
						onClick={onNewLabel}
					>
						<Icon name="plus" size={18} />
					</button>
				</div>
				{labelsError && labels === null && <p className="nav-error">Labels are not available.</p>}
				<ul className="nav-list">
					{userLabels.map((label) => {
						const active = view.kind === "label" && view.labelId === label.id;
						const depth = label.name.split("/").length - 1;
						const shortName = label.name.split("/").pop() || label.name;
						return (
							<li key={label.id} className="nav-label-row">
								<Link
									to={viewPath({ kind: "label", labelId: label.id })}
									className={active ? "nav-item nav-item-active" : "nav-item"}
									aria-current={active ? "page" : undefined}
									style={{ paddingInlineStart: `${16 + depth * 16}px` }}
									title={label.name}
								>
									<Icon name="tag" />
									<span className="nav-name">{shortName}</span>
									{label.threads_unread > 0 && (
										<span className="nav-count">
											{label.threads_unread}
											<span className="visually-hidden"> unread</span>
										</span>
									)}
								</Link>
								<button
									type="button"
									className="icon-button icon-button-small nav-label-delete"
									aria-label={`Delete label ${label.name}`}
									title="Delete label"
									onClick={() => onDeleteLabel(label)}
								>
									<Icon name="trash" size={16} />
								</button>
							</li>
						);
					})}
					{labels !== null && userLabels.length === 0 && <li className="nav-empty">No labels yet.</li>}
				</ul>
				<p className="nav-hint">
					Press <kbd>?</kbd> for keyboard shortcuts.
				</p>
			</nav>
		</>
	);
}
