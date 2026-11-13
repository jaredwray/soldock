import type { DriveItem } from "@soldock/contracts";
import { formatBytes, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { type DriveView, itemPath } from "../../routes.ts";
import type { ListState } from "./data.ts";
import { Menu, type MenuItem } from "./Menu.tsx";
import { emptyText, type ItemOrder, itemIcon, kindName, ownerName } from "./model.ts";

interface ItemListProps {
	view: DriveView;
	title: string;
	list: ListState;
	ownSpaceId: string;
	/** The display name of each principal, by id. */
	names: ReadonlyMap<string, string>;
	selected: ReadonlySet<string>;
	order: ItemOrder;
	onOrder: (order: ItemOrder) => void;
	onToggleSelect: (itemId: string) => void;
	onToggleStar: (item: DriveItem) => void;
	onOpenFile: (item: DriveItem) => void;
	menuItems: (item: DriveItem) => MenuItem[];
	onLoadMore: () => void;
	onRetry: () => void;
}

/** The items of a view, as a table. The folder view can sort by the name or by the last change. */
export function ItemList(props: ItemListProps) {
	const { list, view } = props;
	const showOwner = view.kind === "shared" || view.kind === "starred";
	const sortable = view.kind === "folder";
	const inTrash = view.kind === "trash";

	if (list.status === "loading") {
		return (
			<div className="list-state" aria-live="polite">
				<span className="spinner" aria-hidden="true" />
				Loading items…
			</div>
		);
	}
	if (list.status === "error") {
		return (
			<div className="list-state" role="alert">
				<p>The items did not load. {list.error}</p>
				<button type="button" className="button" onClick={props.onRetry}>
					Try again
				</button>
			</div>
		);
	}
	if (list.items.length === 0) {
		// A page of the starred or the shared view can have no item, because the person lost the access
		// to each item of that page. The list can still have more pages.
		return (
			<div className="list-state list-empty">
				<Icon name={view.kind === "search" ? "search" : view.kind === "trash" ? "trash" : "folder"} size={40} />
				<p>{list.nextCursor !== null ? "This page has no items that you can open." : emptyText(view)}</p>
				{list.nextCursor !== null && (
					<button type="button" className="button" onClick={props.onLoadMore} disabled={list.loadingMore}>
						{list.loadingMore ? "Loading…" : "More"}
					</button>
				)}
			</div>
		);
	}

	return (
		<>
			<table className="drive-table" aria-label={props.title}>
				<thead>
					<tr>
						<th scope="col" className="drive-col-check">
							<span className="visually-hidden">Select</span>
						</th>
						{!inTrash && (
							<th scope="col" className="drive-col-star">
								<span className="visually-hidden">Star</span>
							</th>
						)}
						<th scope="col" aria-sort={sortable && props.order === "name" ? "ascending" : undefined}>
							{sortable ? (
								<SortButton label="Name" active={props.order === "name"} onClick={() => props.onOrder("name")} />
							) : (
								"Name"
							)}
						</th>
						{showOwner && (
							<th scope="col" className="drive-col-owner">
								Owner
							</th>
						)}
						<th
							scope="col"
							className="drive-col-modified"
							aria-sort={sortable && props.order === "modified" ? "descending" : undefined}
						>
							{sortable ? (
								<SortButton
									label="Last change"
									active={props.order === "modified"}
									onClick={() => props.onOrder("modified")}
								/>
							) : inTrash ? (
								"In the trash from"
							) : (
								"Last change"
							)}
						</th>
						<th scope="col" className="drive-col-size">
							Size
						</th>
						<th scope="col" className="drive-col-more">
							<span className="visually-hidden">Actions</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{list.items.map((item) => (
						<ItemRow
							key={item.id}
							item={item}
							showOwner={showOwner}
							inTrash={inTrash}
							owner={ownerName(item.space_id, props.ownSpaceId, props.names)}
							selected={props.selected.has(item.id)}
							onToggleSelect={props.onToggleSelect}
							onToggleStar={props.onToggleStar}
							onOpenFile={props.onOpenFile}
							menuItems={props.menuItems(item)}
						/>
					))}
				</tbody>
			</table>
			<div className="list-footer">
				{list.nextCursor !== null && (
					<button type="button" className="button" onClick={props.onLoadMore} disabled={list.loadingMore}>
						{list.loadingMore ? "Loading…" : "More"}
					</button>
				)}
				<span className="muted">
					{list.items.length} {list.items.length === 1 ? "item" : "items"}
					{list.nextCursor !== null ? " shown" : ""}
				</span>
			</div>
		</>
	);
}

function SortButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			className={active ? "drive-sort drive-sort-active" : "drive-sort"}
			title={`Sort by ${label.toLowerCase()}`}
			onClick={onClick}
		>
			{label}
			{active && <Icon name="chevronDown" size={14} />}
		</button>
	);
}

interface ItemRowProps {
	item: DriveItem;
	showOwner: boolean;
	inTrash: boolean;
	owner: string;
	selected: boolean;
	onToggleSelect: (itemId: string) => void;
	onToggleStar: (item: DriveItem) => void;
	onOpenFile: (item: DriveItem) => void;
	menuItems: MenuItem[];
}

function ItemRow({
	item,
	showOwner,
	inTrash,
	owner,
	selected,
	onToggleSelect,
	onToggleStar,
	onOpenFile,
	menuItems,
}: ItemRowProps) {
	const path = itemPath(item);
	const date = inTrash && item.trashed_at ? item.trashed_at : item.modified_at;
	const name = (
		<>
			<Icon name={itemIcon(item)} className={`drive-kind drive-kind-${item.kind}`} />
			<span className="drive-name-text">{item.name}</span>
			<span className="visually-hidden">{`, ${kindName(item).toLowerCase()}`}</span>
		</>
	);
	return (
		<tr className={selected ? "drive-row drive-row-selected" : "drive-row"}>
			<td className="drive-col-check">
				<label className="drive-check">
					<input type="checkbox" className="checkbox" checked={selected} onChange={() => onToggleSelect(item.id)} />
					<span className="visually-hidden">{`Select ${item.name}`}</span>
				</label>
			</td>
			{!inTrash && (
				<td className="drive-col-star">
					<button
						type="button"
						className={
							item.starred ? "icon-button icon-button-small icon-button-star" : "icon-button icon-button-small"
						}
						aria-label={item.starred ? `Remove the star from ${item.name}` : `Put a star on ${item.name}`}
						aria-pressed={item.starred}
						title={item.starred ? "Remove star" : "Star"}
						onClick={() => onToggleStar(item)}
					>
						<Icon name="star" size={18} filled={item.starred} />
					</button>
				</td>
			)}
			<th scope="row" className="drive-col-name">
				<span className="drive-name">
					{inTrash ? (
						<span className="drive-name-link drive-name-plain">{name}</span>
					) : path !== null ? (
						<Link to={path} className="drive-name-link">
							{name}
						</Link>
					) : (
						<button type="button" className="drive-name-link" onClick={() => onOpenFile(item)}>
							{name}
						</button>
					)}
					{item.shared && (
						<span className="drive-shared-mark" title="Shared">
							<Icon name="team" size={16} />
							<span className="visually-hidden">Shared</span>
						</span>
					)}
				</span>
			</th>
			{showOwner && <td className="drive-col-owner">{owner}</td>}
			<td className="drive-col-modified">
				<time dateTime={date}>{shortDate(date)}</time>
				{!inTrash && item.modified_by && (
					<span className="drive-modified-by">{` ${item.modified_by.display_name}`}</span>
				)}
			</td>
			<td className="drive-col-size">{item.kind === "folder" ? "" : formatBytes(item.size)}</td>
			<td className="drive-col-more">
				{menuItems.length > 0 && (
					<Menu
						className="icon-button icon-button-small"
						label={`Actions for ${item.name}`}
						title="More actions"
						items={menuItems}
					>
						<Icon name="more" size={18} />
					</Menu>
				)}
			</td>
		</tr>
	);
}
