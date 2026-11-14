import { Icon, type IconName } from "../../lib/icons.tsx";

/** An icon button in the actions cell of an admin table. The label is the accessible name and the tooltip. */
export function RowButton({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
	return (
		<button type="button" className="icon-button row-button" aria-label={label} title={label} onClick={onClick}>
			<Icon name={icon} size={18} />
		</button>
	);
}
