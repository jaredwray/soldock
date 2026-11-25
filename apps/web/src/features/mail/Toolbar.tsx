import type { Label } from "@asterra/contracts";
import { type ReactNode, useEffect, useRef } from "react";
import { Icon, type IconName } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { Select } from "../../lib/Select.tsx";
import type { MailView } from "../../routes.ts";
import type { MailAction } from "./actions.ts";

interface ToolbarProps {
	view: MailView;
	title: string;
	/** The icon of the view, before the title. */
	icon: IconName;
	/** The search box of Mail, at the right of the row. */
	search: ReactNode;
	/** "list" shows the select-all box. "thread" shows the back button. */
	mode: "list" | "thread";
	/** The number of threads that the actions change: the selection, or 1 for an open thread. */
	targetCount: number;
	selection: "none" | "some" | "all";
	anyUnread: boolean;
	allStarred: boolean;
	/** True when each thread of the targets is in Reply later. The button then takes them out. */
	allReplyLater: boolean;
	userLabels: readonly Label[];
	listEmpty: boolean;
	/** True in the mailbox of an agent: no selection and no actions. */
	readOnly: boolean;
	/**
	 * True in a search of the mail that the Screener holds. Only the read state and the star change there:
	 * a person screens the sender in or out to move the mail.
	 */
	held: boolean;
	onToggleAll: () => void;
	onAction: (action: MailAction) => void;
	onBack: () => void;
	onRefresh: () => void;
	/** The path of the settings view of the mailbox. */
	settingsPath: string;
}

/**
 * The header row of Mail: the title of the view, the actions on the selection or on the open thread,
 * the search box, Refresh and the settings of the mailbox.
 */
export function Toolbar(props: ToolbarProps) {
	const { view, mode, targetCount, anyUnread, allStarred, allReplyLater, userLabels, held, onAction } = props;
	const inSpam = view.kind === "system" && view.view === "spam";
	const inTrash = view.kind === "system" && view.view === "trash";
	const moves = !inSpam && !inTrash && !held;
	const hasTargets = !props.readOnly && targetCount > 0;

	return (
		<div className={hasTargets ? "toolbar toolbar-has-targets" : "toolbar"}>
			{mode === "thread" ? (
				<ToolButton icon="back" label="Back to the list" onClick={props.onBack} />
			) : (
				!props.readOnly && (
					<SelectAll selection={props.selection} disabled={props.listEmpty} onToggle={props.onToggleAll} />
				)
			)}
			{mode === "list" && (
				<div className="page-title">
					<Icon name={props.icon} />
					<h1 className="toolbar-title">{hasTargets ? `${targetCount} selected` : props.title}</h1>
				</div>
			)}
			{hasTargets && (
				<div className="toolbar-actions">
					{inSpam && <TextButton icon="restore" label="Not spam" onClick={() => onAction("notSpam")} />}
					{inTrash && <TextButton icon="restore" label="Restore" onClick={() => onAction("restore")} />}
					{moves && (
						<>
							<ToolButton icon="archive" label="Archive" shortcut="e" onClick={() => onAction("archive")} />
							<ToolButton icon="spam" label="Report spam" onClick={() => onAction("spam")} />
							<ToolButton icon="trash" label="Move to Trash" shortcut="#" onClick={() => onAction("trash")} />
						</>
					)}
					{!held && <span className="toolbar-divider" aria-hidden="true" />}
					{anyUnread ? (
						<ToolButton icon="mailOpen" label="Mark as read" onClick={() => onAction("read")} />
					) : (
						<ToolButton icon="mail" label="Mark as unread" onClick={() => onAction("unread")} />
					)}
					{!inSpam && !inTrash && (
						<ToolButton
							icon="star"
							label={allStarred ? "Remove star" : "Star"}
							shortcut="s"
							filled={allStarred}
							onClick={() => onAction(allStarred ? "unstar" : "star")}
						/>
					)}
					{/* Held mail moves only when a person screens its sender, so it has no Reply later. */}
					{moves &&
						(allReplyLater ? (
							<ToolButton
								icon="check"
								label="Done: remove from Reply later"
								shortcut="l"
								onClick={() => onAction("replyLaterDone")}
							/>
						) : (
							<ToolButton icon="clock" label="Reply later" shortcut="l" onClick={() => onAction("replyLater")} />
						))}
					{moves && userLabels.length > 0 && (
						<LabelPicker labels={userLabels} onPick={(id) => onAction({ label: id })} />
					)}
					{view.kind === "label" && (
						<TextButton icon="tag" label="Remove label" onClick={() => onAction({ unlabel: view.labelId })} />
					)}
				</div>
			)}
			<span className="toolbar-spacer" />
			{props.search}
			{!hasTargets && (
				<>
					<ToolButton icon="refresh" label="Refresh" onClick={props.onRefresh} />
					<Link to={props.settingsPath} className="icon-button" aria-label="Mailbox settings" title="Mailbox settings">
						<Icon name="settings" />
					</Link>
				</>
			)}
		</div>
	);
}

function SelectAll({
	selection,
	disabled,
	onToggle,
}: {
	selection: "none" | "some" | "all";
	disabled: boolean;
	onToggle: () => void;
}) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (ref.current) ref.current.indeterminate = selection === "some";
	}, [selection]);
	return (
		<label className="select-all" title="Select all">
			<input
				ref={ref}
				type="checkbox"
				className="checkbox"
				checked={selection === "all"}
				disabled={disabled}
				onChange={onToggle}
			/>
			<span className="visually-hidden">Select all conversations</span>
		</label>
	);
}

function ToolButton({
	icon,
	label,
	shortcut,
	filled,
	onClick,
}: {
	icon: IconName;
	label: string;
	shortcut?: string;
	filled?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			className={filled ? "icon-button icon-button-star" : "icon-button"}
			aria-label={label}
			title={shortcut ? `${label} (${shortcut})` : label}
			aria-keyshortcuts={shortcut === "#" ? "Shift+3" : shortcut}
			onClick={onClick}
		>
			<Icon name={icon} filled={filled ?? false} />
		</button>
	);
}

function TextButton({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
	return (
		<button type="button" className="button button-small" onClick={onClick}>
			<Icon name={icon} size={16} />
			{label}
		</button>
	);
}

function LabelPicker({ labels, onPick }: { labels: readonly Label[]; onPick: (labelId: string) => void }) {
	// The control has no value: each choice applies a label, and the control shows "Label as…" again.
	return (
		<span className="label-picker">
			<Select
				className="label-select"
				label="Apply a label"
				icon="tag"
				value=""
				placeholder="Label as…"
				options={labels.map((label) => ({ value: label.id, label: label.name }))}
				onChange={onPick}
			/>
		</span>
	);
}
