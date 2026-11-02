import type { Label } from "@soldock/contracts";
import { useEffect, useRef } from "react";
import { Icon, type IconName } from "../../lib/icons.tsx";
import type { MailView } from "../../routes.ts";
import type { MailAction } from "./actions.ts";

interface ToolbarProps {
	view: MailView;
	title: string;
	/** "list" shows the select-all box. "thread" shows the back button. */
	mode: "list" | "thread";
	/** The number of threads that the actions change: the selection, or 1 for an open thread. */
	targetCount: number;
	selection: "none" | "some" | "all";
	anyUnread: boolean;
	allStarred: boolean;
	userLabels: readonly Label[];
	listEmpty: boolean;
	onToggleAll: () => void;
	onAction: (action: MailAction) => void;
	onBack: () => void;
	onRefresh: () => void;
}

/** The actions above the list or the open thread. They change the selection or the open thread. */
export function Toolbar(props: ToolbarProps) {
	const { view, mode, targetCount, anyUnread, allStarred, userLabels, onAction } = props;
	const inSpam = view.kind === "system" && view.view === "spam";
	const inTrash = view.kind === "system" && view.view === "trash";
	const hasTargets = targetCount > 0;

	return (
		<div className="toolbar">
			{mode === "list" ? (
				<SelectAll selection={props.selection} disabled={props.listEmpty} onToggle={props.onToggleAll} />
			) : (
				<ToolButton icon="back" label="Back to the list" onClick={props.onBack} />
			)}
			{!hasTargets && <ToolButton icon="refresh" label="Refresh" onClick={props.onRefresh} />}
			{hasTargets && (
				<div className="toolbar-actions">
					{inSpam && <TextButton icon="restore" label="Not spam" onClick={() => onAction("notSpam")} />}
					{inTrash && <TextButton icon="restore" label="Restore" onClick={() => onAction("restore")} />}
					{!inSpam && !inTrash && (
						<>
							<ToolButton icon="archive" label="Archive" shortcut="e" onClick={() => onAction("archive")} />
							<ToolButton icon="spam" label="Report spam" onClick={() => onAction("spam")} />
							<ToolButton icon="trash" label="Move to Trash" shortcut="#" onClick={() => onAction("trash")} />
						</>
					)}
					<span className="toolbar-divider" aria-hidden="true" />
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
					{!inSpam && !inTrash && userLabels.length > 0 && (
						<LabelPicker labels={userLabels} onPick={(id) => onAction({ label: id })} />
					)}
					{view.kind === "label" && (
						<TextButton icon="tag" label="Remove label" onClick={() => onAction({ unlabel: view.labelId })} />
					)}
				</div>
			)}
			<span className="toolbar-spacer" />
			{mode === "list" && <h1 className="toolbar-title">{hasTargets ? `${targetCount} selected` : props.title}</h1>}
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
	return (
		<label className="label-picker">
			<span className="visually-hidden">Apply a label</span>
			<Icon name="tag" size={18} />
			<select
				className="label-select"
				value=""
				onChange={(event) => {
					if (event.target.value) onPick(event.target.value);
				}}
			>
				<option value="">Label as…</option>
				{labels.map((label) => (
					<option key={label.id} value={label.id}>
						{label.name}
					</option>
				))}
			</select>
		</label>
	);
}
