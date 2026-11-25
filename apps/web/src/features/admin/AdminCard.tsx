import { type ReactNode, useState } from "react";
import { Icon, type IconName } from "../../lib/icons.tsx";

interface AdminCardProps {
	icon: IconName;
	name: ReactNode;
	address: string;
	/** The chips at the right of the summary. */
	chips: ReactNode;
	/** The parts of the open card. Each part is a direct child, so it gets a line above it. */
	children: ReactNode;
}

/**
 * One shared mailbox or one shared drive in an Admin section. The card shows an icon, the name, the
 * address and chips. A click opens the card and shows its parts. The parts load their own data, so the
 * card renders them at the first open only. The parts stay after the card closes, so a form keeps its text.
 * Members has no such cards: each member has its own page.
 */
export function AdminCard({ icon, name, address, chips, children }: AdminCardProps) {
	const [opened, setOpened] = useState(false);
	return (
		<details
			className="admin-card"
			onToggle={(event) => {
				if (event.currentTarget.open) setOpened(true);
			}}
		>
			<summary className="admin-card-summary">
				<span className="avatar member-avatar" aria-hidden="true">
					<Icon name={icon} size={18} />
				</span>
				<span className="admin-card-text">
					<span className="admin-card-name">{name}</span>
					<span className="admin-card-address">{address}</span>
				</span>
				<span className="admin-card-chips">{chips}</span>
				<Icon name="chevronDown" className="admin-card-chevron" />
			</summary>
			{opened && <div className="admin-card-body">{children}</div>}
		</details>
	);
}
