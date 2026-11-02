// Vite's `?raw` imports, used by tests to read config files inside workerd.
declare module "*?raw" {
	const content: string;
	export default content;
}

type D1Migration = import("cloudflare:test").D1Migration;
