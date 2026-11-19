import { useEffect, useRef } from "react";
import { useAdminAccess } from "../features/admin/access.ts";
import { useSession } from "../features/auth/session.tsx";
import { Icon, type IconName } from "../lib/icons.tsx";
import { Link } from "../lib/router.tsx";
import { CHAT_PATH, DRIVE_PATH, INBOX_PATH, type Route } from "../routes.ts";
import { AccountMenu } from "./AccountMenu.tsx";
import { BrandMark } from "./BrandMark.tsx";
import { MENU_BUTTON_ID, type Product, productOf, RAIL_ID } from "./nav.ts";

// Meet and Slides get an entry here when they exist.
const PRODUCTS: readonly { product: Product; name: string; icon: IconName; home: string }[] = [
	{ product: "mail", name: "Mail", icon: "mail", home: INBOX_PATH },
	{ product: "chat", name: "Chat", icon: "chat", home: CHAT_PATH },
	{ product: "drive", name: "Drive", icon: "drive", home: DRIVE_PATH },
];

interface RailProps {
	route: Route;
	/** True while the navigation drawer is open, at 900px and below. */
	open: boolean;
	/** True when the page has a sidebar. The sidebar then gets the focus when the drawer opens. */
	hasSidebar: boolean;
}

/**
 * The rail at the left of each page: the mark of Asterra, the products, Admin, Settings and the
 * account button. At 900px and below it is part of the drawer that the menu button opens.
 */
export function Rail({ route, open, hasSidebar }: RailProps) {
	const { whoami } = useSession();
	const showAdmin = useAdminAccess(whoami.principal);
	const product = productOf(route);
	const navRef = useRef<HTMLElement>(null);
	const wasOpen = useRef(open);

	// The drawer: on a page with no sidebar, the focus goes to the first link of the rail when the
	// drawer opens. When it closes, the focus goes back to the menu button, if the focus was in the rail.
	useEffect(() => {
		const nav = navRef.current;
		if (!nav || open === wasOpen.current) return;
		wasOpen.current = open;
		if (open) {
			if (!hasSidebar) nav.querySelector<HTMLElement>("a[href]")?.focus();
		} else if (nav.contains(document.activeElement) || (!hasSidebar && document.activeElement === document.body)) {
			document.getElementById(MENU_BUTTON_ID)?.focus();
		}
	}, [open, hasSidebar]);

	return (
		<nav id={RAIL_ID} ref={navRef} className={open ? "rail rail-open" : "rail"} aria-label="Products">
			<Link to={INBOX_PATH} className="rail-brand" aria-label="Asterra, go to the inbox">
				<BrandMark />
			</Link>
			{PRODUCTS.map((entry) => (
				<Link
					key={entry.product}
					to={entry.home}
					className="rail-link"
					aria-current={entry.product === product ? "true" : undefined}
				>
					<Icon name={entry.icon} size={22} />
					<span>{entry.name}</span>
				</Link>
			))}
			{showAdmin && (
				<>
					<hr className="rail-rule" />
					<Link to="/admin" className="rail-link" aria-current={route.page === "admin" ? "page" : undefined}>
						<Icon name="shield" size={22} />
						<span>Admin</span>
					</Link>
				</>
			)}
			<span className="rail-spacer" />
			<Link to="/settings" className="rail-link" aria-current={route.page === "settings" ? "page" : undefined}>
				<Icon name="settings" size={22} />
				<span>Settings</span>
			</Link>
			<AccountMenu />
		</nav>
	);
}
