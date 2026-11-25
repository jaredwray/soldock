import type { ReactNode } from "react";
import { Icon, type IconName } from "../lib/icons.tsx";
import { Link } from "../lib/router.tsx";

interface PageHeaderProps {
	title: string;
	icon?: IconName;
	/** A link at the left of the title, back to the page above it. `label` is its name and its tooltip. */
	back?: { to: string; label: string } | undefined;
	/** The controls at the right of the row. */
	children?: ReactNode;
}

/** The header row of a page: a back link, an icon, the title of the page, and controls at the right. */
export function PageHeader({ title, icon, back, children }: PageHeaderProps) {
	return (
		<div className="page-header">
			{back && (
				<Link to={back.to} className="icon-button" aria-label={back.label} title={back.label}>
					<Icon name="back" />
				</Link>
			)}
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
