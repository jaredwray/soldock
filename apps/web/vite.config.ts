import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dock Worker serves `dist` as static assets. In development, `wrangler dev` runs dock on
// port 8787, and the Vite dev server sends the Worker-owned paths to it.
const DOCK = "http://localhost:8787";

export default defineConfig({
	plugins: [react()],
	build: {
		outDir: "dist",
	},
	server: {
		proxy: {
			"/api": DOCK,
			"/auth": DOCK,
			"/mcp": DOCK,
		},
	},
});
