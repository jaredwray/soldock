import type { Route } from "../routes.ts";

/** The element id of the search box. The `/` shortcut moves the focus to it. */
export const SEARCH_INPUT_ID = "app-search";

/** The element id of the menu button. The focus goes back to it when the navigation drawer closes. */
export const MENU_BUTTON_ID = "app-menu-button";

/** The element id of the rail. On a page with no sidebar, the menu button controls the rail. */
export const RAIL_ID = "app-rail";

/** The element ids of the sidebars. The menu button controls the sidebar of the current product. */
export const MAIL_NAV_ID = "mail-nav";
export const DRIVE_NAV_ID = "drive-nav";
export const CHAT_NAV_ID = "chat-nav";
export const ADMIN_NAV_ID = "admin-nav";
export const SETTINGS_NAV_ID = "settings-nav";

/** The pages with a sidebar, and the element id of each sidebar. */
const NAV_IDS: Partial<Record<Route["page"], string>> = {
	mail: MAIL_NAV_ID,
	"mail-settings": MAIL_NAV_ID,
	"mail-screener": MAIL_NAV_ID,
	drive: DRIVE_NAV_ID,
	chat: CHAT_NAV_ID,
	admin: ADMIN_NAV_ID,
	settings: SETTINGS_NAV_ID,
};

/** The element id of the sidebar of a page, or null for a page with no sidebar. */
export function sidebarId(route: Route): string | null {
	return NAV_IDS[route.page] ?? null;
}

/** The products of Asterra. A doc and a sheet are part of Drive. */
export type Product = "mail" | "drive" | "chat" | "calendar";

/** The product of a page, or null for a page that is not part of a product, for example Settings. */
export function productOf(route: Route): Product | null {
	switch (route.page) {
		case "mail":
		case "mail-settings":
		case "mail-screener":
			return "mail";
		case "drive":
		case "doc":
		case "sheet":
			return "drive";
		case "chat":
			return "chat";
		case "calendar":
			return "calendar";
		default:
			return null;
	}
}
