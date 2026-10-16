// Vite's `?raw` imports, used by tests to read config files inside workerd.
declare module "*?raw" {
	const content: string;
	export default content;
}
