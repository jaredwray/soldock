import type { ReactNode } from "react";
import { Icon, type IconName } from "../lib/icons.tsx";

interface PageHeaderProps {
	title: string;
	icon?: IconName;
	/** The controls at the right of the row. */
	children?: ReactNode;
}

/** The header row of a page: an icon, the title of the page, and controls at the right. */
export function PageHeader({ title, icon, children }: PageHeaderProps) {
	return (
		<div className="page-header">
			<div className="page-title">
				{icon && <Icon name={icon} />}
				<h1 className="page-heading">{title}</h1>
			</div>
			{children && (
				<>
					<span className="toolbar-spacer" />
					{children}
				</>
			)}
		</div>
	);
}
