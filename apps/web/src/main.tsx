import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { followAppearance } from "./lib/appearance.ts";

// The appearance applies before the first render, so the page does not show the wrong colors first.
followAppearance();

const root = document.getElementById("root");
if (!root) throw new Error("The page has no #root element");

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
