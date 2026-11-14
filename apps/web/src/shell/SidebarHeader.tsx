/** The top of a sidebar: the name of the product, and one line of text under it. */
export function SidebarHeader({ title, subtitle }: { title: string; subtitle: string }) {
	return (
		<hgroup className="sidebar-header">
			<h2 className="sidebar-title">{title}</h2>
			<p className="sidebar-subtitle" title={subtitle}>
				{subtitle}
			</p>
		</hgroup>
	);
}
