import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import rootPackage from "../../package.json";

// The dock Worker serves `dist` as static assets. In development, `wrangler dev` runs dock on
// port 8787, and the Vite dev server sends the Worker-owned paths to it.
const DOCK = "http://localhost:8787";

export default defineConfig({
	plugins: [react()],
	// The version of Asterra is the version in the root package.json. The build puts only this string
	// into the bundle (src/lib/version.ts).
	define: {
		__ASTERRA_VERSION__: JSON.stringify(rootPackage.version),
	},
	build: {
		outDir: "dist",
	},
	server: {
		proxy: {
			"/api": DOCK,
			"/auth": DOCK,
			"/mcp": DOCK,
			// The room sockets of Chat.
			"/ws": { target: DOCK, ws: true },
		},
	},
});
