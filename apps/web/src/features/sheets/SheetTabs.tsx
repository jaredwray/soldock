import { SHEET_LIMITS, type Tab } from "@soldock/contracts";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Icon } from "../../lib/icons.tsx";
import { useToast } from "../../lib/toast.tsx";
import { Menu, type MenuItem } from "../drive/Menu.tsx";
import type { TabAction } from "./store.ts";

/** The element id of a tab. The panel of the grid names its tab with it in `aria-labelledby`. */
export function tabElementId(baseId: string, tabId: string): string {
	return `${baseId}-${tabId}`;
}

interface SheetTabsProps {
	/** The base of the element ids. */
	baseId: string;
	/** The element id of the panel that shows the grid of the active tab. */
	panelId: string;
	tabs: readonly Tab[];
	activeTab: string;
	readOnly: boolean;
	onSelect: (tabId: string) => void;
	/** Runs a change of the tabs. It throws the error of the server. */
	onChange: (action: TabAction) => Promise<void>;
}

/**
 * The tab bar under the grid. Each tab is a `tab` of a `tablist`: the arrow keys, Home and End move
 * the focus between the tabs, and Enter or a click shows a tab. An editor gets the add button, the
 * menu of the active tab, and a rename with a double click.
 */
export function SheetTabs({ baseId, panelId, tabs, activeTab, readOnly, onSelect, onChange }: SheetTabsProps) {
	const toast = useToast();
	const [renaming, setRenaming] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<Tab | null>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const index = tabs.findIndex((tab) => tab.id === activeTab);
	const active = tabs[index];

	// The active tab scrolls into view, for example a new tab at the end of a long bar.
	useEffect(() => {
		const element = document.getElementById(tabElementId(baseId, activeTab));
		element?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
	}, [baseId, activeTab]);

	/** Runs a change of the tabs, and shows the error of the server in a toast. */
	function run(action: TabAction) {
		onChange(action).catch((error: unknown) => toast({ message: errorMessage(error), tone: "error" }));
	}

	function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		const buttons = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
		const current = buttons.indexOf(document.activeElement as HTMLElement);
		if (current < 0) return;
		const last = buttons.length - 1;
		const next: Record<string, number> = {
			ArrowLeft: current === 0 ? last : current - 1,
			ArrowRight: current === last ? 0 : current + 1,
			Home: 0,
			End: last,
		};
		const target = next[event.key];
		if (target === undefined) return;
		event.preventDefault();
		buttons[target]?.focus();
	}

	const items: MenuItem[] = [];
	if (active) {
		items.push({ key: "rename", label: "Rename", icon: "pencil", onSelect: () => setRenaming(active.id) });
		if (tabs.length < SHEET_LIMITS.tabs) {
			items.push({
				key: "duplicate",
				label: "Duplicate",
				icon: "copy",
				onSelect: () => run({ kind: "duplicate", tabId: active.id }),
			});
		}
		if (index > 0) {
			items.push({
				key: "left",
				label: "Move left",
				icon: "chevronLeft",
				onSelect: () => run({ kind: "move", tabId: active.id, index: index - 1 }),
			});
		}
		if (index < tabs.length - 1) {
			items.push({
				key: "right",
				label: "Move right",
				icon: "chevronRight",
				onSelect: () => run({ kind: "move", tabId: active.id, index: index + 1 }),
			});
		}
		if (tabs.length > 1) {
			items.push({ key: "delete", label: "Delete", icon: "trash", danger: true, onSelect: () => setDeleting(active) });
		}
	}

	return (
		<div className="sheet-tabs">
			{!readOnly && (
				<>
					<button
						type="button"
						className="icon-button sheet-tabs-button"
						aria-label="Add a tab"
						title="Add a tab"
						disabled={tabs.length >= SHEET_LIMITS.tabs}
						onClick={() => run({ kind: "add" })}
					>
						<Icon name="plus" size={18} />
					</button>
					{active && (
						<Menu
							label={`Actions for the tab ${active.name}`}
							menuLabel={`Tab ${active.name}`}
							className="icon-button sheet-tabs-button"
							items={items}
							align="start"
						>
							<Icon name="more" size={18} />
						</Menu>
					)}
				</>
			)}
			<div ref={listRef} role="tablist" aria-label="Tabs" className="sheet-tablist" onKeyDown={onListKeyDown}>
				{tabs.map((tab) =>
					tab.id === renaming ? (
						<RenameField
							key={tab.id}
							tab={tab}
							onDone={(name) => {
								setRenaming(null);
								if (name !== null && name !== tab.name) run({ kind: "rename", tabId: tab.id, name });
							}}
						/>
					) : (
						<button
							key={tab.id}
							type="button"
							role="tab"
							id={tabElementId(baseId, tab.id)}
							aria-selected={tab.id === activeTab}
							aria-controls={tab.id === activeTab ? panelId : undefined}
							tabIndex={tab.id === activeTab ? 0 : -1}
							className="sheet-tab"
							title={readOnly ? undefined : "Double-click to rename"}
							onClick={() => onSelect(tab.id)}
							onDoubleClick={() => {
								if (!readOnly) setRenaming(tab.id);
							}}
						>
							{tab.name}
						</button>
					),
				)}
			</div>
			{deleting && (
				<ConfirmDialog
					title={`Delete the tab ${deleting.name}?`}
					confirmLabel="Delete"
					danger
					onConfirm={() => onChange({ kind: "delete", tabId: deleting.id })}
					onClose={() => setDeleting(null)}
				>
					<p>
						The tab and each of its cells are deleted. A formula in a different tab that reads this tab gets{" "}
						<code>#REF!</code>.
					</p>
				</ConfirmDialog>
			)}
		</div>
	);
}

interface RenameFieldProps {
	tab: Tab;
	/** Gets the new name, or null after Escape. */
	onDone: (name: string | null) => void;
}

/** The field that takes the place of a tab during a rename. Enter or a blur keeps the name, and Escape cancels. */
function RenameField({ tab, onDone }: RenameFieldProps) {
	const [value, setValue] = useState(tab.name);
	const doneRef = useRef(false);
	const inputRef = useRef<HTMLInputElement>(null);

	useLayoutEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);

	function finish(name: string | null) {
		if (doneRef.current) return;
		doneRef.current = true;
		const trimmed = name?.trim() ?? null;
		onDone(trimmed === "" ? null : trimmed);
	}

	return (
		<input
			ref={inputRef}
			className="sheet-tab-rename"
			aria-label={`New name of the tab ${tab.name}`}
			value={value}
			maxLength={SHEET_LIMITS.tabNameChars}
			spellCheck={false}
			autoComplete="off"
			size={Math.max(6, value.length + 1)}
			onChange={(event) => setValue(event.target.value)}
			onBlur={() => finish(value)}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					finish(value);
				} else if (event.key === "Escape") {
					event.preventDefault();
					finish(null);
				}
			}}
		/>
	);
}
