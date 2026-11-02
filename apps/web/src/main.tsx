// This import must stay first: it sets the Zod config before @soldock/contracts loads.
import "./lib/zod-jitless.ts";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("The page has no #root element");

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
