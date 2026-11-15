import { SHEET_LIMITS, type Tab } from "@soldock/contracts";
import { type CSSProperties, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
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
	const barRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	/** The tab that gets the focus back when a rename ends with Enter or Escape. */
	const refocusRef = useRef<string | null>(null);
	const index = tabs.findIndex((tab) => tab.id === activeTab);
	const active = tabs[index];
	// Somebody else can delete the tab during its rename. The field then goes, with no rename.
	const renamingTab = renaming === null ? undefined : tabs.find((tab) => tab.id === renaming);

	// The active tab scrolls into view, for example a new tab at the end of a long bar.
	useEffect(() => {
		const element = document.getElementById(tabElementId(baseId, activeTab));
		element?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
	}, [baseId, activeTab]);

	// The rename field leaves the page, so the focus goes back to its tab and not to the top of the page.
	useEffect(() => {
		if (renaming !== null || refocusRef.current === null) return;
		document.getElementById(tabElementId(baseId, refocusRef.current))?.focus();
		refocusRef.current = null;
	}, [baseId, renaming]);

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
		<div ref={barRef} className="sheet-tabs">
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
				{tabs.map((tab) => (
					<button
						key={tab.id}
						type="button"
						role="tab"
						id={tabElementId(baseId, tab.id)}
						aria-selected={tab.id === activeTab}
						aria-controls={tab.id === activeTab ? panelId : undefined}
						tabIndex={tab.id === activeTab ? 0 : -1}
						// During a rename, the field covers the tab. The tab keeps its place, and the panel keeps its name.
						className={tab.id === renaming ? "sheet-tab sheet-tab-renaming" : "sheet-tab"}
						title={readOnly ? undefined : "Double-click to rename"}
						onClick={() => onSelect(tab.id)}
						onDoubleClick={() => {
							if (!readOnly) setRenaming(tab.id);
						}}
					>
						{tab.name}
					</button>
				))}
			</div>
			{renamingTab && (
				<RenameField
					key={renamingTab.id}
					tab={renamingTab}
					bar={barRef.current}
					tabElement={document.getElementById(tabElementId(baseId, renamingTab.id))}
					onDone={(name, refocus) => {
						if (refocus) refocusRef.current = renamingTab.id;
						setRenaming(null);
						if (name !== null && name !== renamingTab.name) run({ kind: "rename", tabId: renamingTab.id, name });
					}}
				/>
			)}
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
	/** The tab bar, and the tab that the field covers. */
	bar: HTMLElement | null;
	tabElement: HTMLElement | null;
	/** Gets the new name, or null after Escape. `refocus` is true after Enter or Escape, and false after a blur. */
	onDone: (name: string | null, refocus: boolean) => void;
}

/**
 * The field of a rename. It is outside the tablist, so the tablist holds only tabs, and it covers its
 * tab. Enter or a blur keeps the name, and Escape cancels.
 */
function RenameField({ tab, bar, tabElement, onDone }: RenameFieldProps) {
	const [value, setValue] = useState(tab.name);
	const [place, setPlace] = useState<CSSProperties>({ visibility: "hidden" });
	const doneRef = useRef(false);
	const inputRef = useRef<HTMLInputElement>(null);

	useLayoutEffect(() => {
		if (bar && tabElement) {
			const outer = bar.getBoundingClientRect();
			const inner = tabElement.getBoundingClientRect();
			// An absolute position starts inside the border of the bar.
			setPlace({
				left: inner.left - outer.left - bar.clientLeft,
				top: inner.top - outer.top - bar.clientTop,
				minWidth: inner.width,
			});
		}
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [bar, tabElement]);

	function finish(name: string | null, refocus: boolean) {
		if (doneRef.current) return;
		doneRef.current = true;
		const trimmed = name?.trim() ?? null;
		onDone(trimmed === "" ? null : trimmed, refocus);
	}

	return (
		<input
			ref={inputRef}
			className="sheet-tab-rename"
			style={place}
			aria-label={`New name of the tab ${tab.name}`}
			value={value}
			maxLength={SHEET_LIMITS.tabNameChars}
			spellCheck={false}
			autoComplete="off"
			size={Math.max(6, value.length + 1)}
			onChange={(event) => setValue(event.target.value)}
			onBlur={() => finish(value, false)}
			onKeyDown={(event) => {
				// The Enter that ends the composition of an input method is not the end of the rename.
				if (event.nativeEvent.isComposing) return;
				if (event.key === "Enter") {
					event.preventDefault();
					finish(value, true);
				} else if (event.key === "Escape") {
					event.preventDefault();
					finish(null, true);
				}
			}}
		/>
	);
}
