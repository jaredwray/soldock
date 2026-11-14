import { useSyncExternalStore } from "react";

// The appearance of the app: Light, Dark or System. The choice is a display setting of one browser.
// It is in localStorage, not on the server. The `dark` class on <html> selects the dark colors of styles.css.

export type Appearance = "light" | "dark" | "system";

/** The localStorage key of the choice. */
export const APPEARANCE_KEY = "soldock:appearance";

/** The choice for a saved value. A missing value or an unknown value gives System. */
export function parseAppearance(value: unknown): Appearance {
	return value === "light" || value === "dark" ? value : "system";
}

/** True when the choice shows the dark colors. System follows the device. */
export function isDark(appearance: Appearance, deviceIsDark: boolean): boolean {
	return appearance === "dark" || (appearance === "system" && deviceIsDark);
}

const DEVICE_DARK = "(prefers-color-scheme: dark)";

/** The choice of this page. It stays when the browser refuses to save it. */
let shown: Appearance = "system";
const listeners = new Set<() => void>();

function savedAppearance(): Appearance {
	try {
		return parseAppearance(localStorage.getItem(APPEARANCE_KEY));
	} catch {
		// The browser can refuse access to localStorage. Then the app follows the device.
		return "system";
	}
}

/** Shows a choice: the `dark` class and the color scheme of <html>, and the choice in `data-appearance`. */
function applyAppearance(appearance: Appearance): void {
	shown = appearance;
	const dark = isDark(appearance, matchMedia(DEVICE_DARK).matches);
	const html = document.documentElement;
	html.classList.toggle("dark", dark);
	html.dataset.appearance = appearance;
	html.style.colorScheme = dark ? "dark" : "light";
	for (const listener of listeners) listener();
}

/** Saves a choice and shows it. */
export function chooseAppearance(appearance: Appearance): void {
	try {
		localStorage.setItem(APPEARANCE_KEY, appearance);
	} catch {
		// The browser can refuse to save. The choice then applies to this page only.
	}
	applyAppearance(appearance);
}

/**
 * Shows the saved choice, and keeps the page in step with the device and with the other tabs.
 * `main.tsx` calls this before the first render, because the CSP allows no inline script.
 */
export function followAppearance(): void {
	applyAppearance(savedAppearance());
	matchMedia(DEVICE_DARK).addEventListener("change", () => {
		if (shown === "system") applyAppearance("system");
	});
	// A different tab changed the choice. When the storage is cleared, the event has no key.
	window.addEventListener("storage", (event) => {
		if (event.key === APPEARANCE_KEY || event.key === null) applyAppearance(savedAppearance());
	});
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The choice that the page shows. The component renders again when the choice changes. */
export function useAppearance(): Appearance {
	return useSyncExternalStore(subscribe, () => shown);
}
