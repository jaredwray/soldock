import { type ComponentProps, lazy, Suspense, useEffect } from "react";
import { Dialog } from "../../lib/Dialog.tsx";
import type { Composer as ComposerComponent } from "./Composer.tsx";

type ComposerProps = ComponentProps<typeof ComposerComponent>;

// The composer and its rich-text editor are a separate chunk, so the first load of the app is
// smaller. The mail app loads the chunk after it starts, so the composer opens at once.

const loadComposer = () => import("./Composer.tsx");

/**
 * The chunk can fail to load: the connection is down, or a deploy removed the files of this
 * version. Then the dialog asks for a reload, and the app does not stop.
 */
function ComposerUnavailable({ onClose }: Pick<ComposerProps, "onClose">) {
	return (
		<Dialog title="The composer did not load" onClose={onClose} className="dialog-small">
			<div className="dialog-body">
				<p>The connection can be down, or a new version of Soldock is available. Reload the page, then try again.</p>
			</div>
			<div className="dialog-actions">
				<button type="button" className="button" onClick={onClose}>
					Close
				</button>
				<button type="button" className="button button-primary" onClick={() => window.location.reload()} data-autofocus>
					Reload
				</button>
			</div>
		</Dialog>
	);
}

const LazyComposer = lazy(() =>
	loadComposer().then(
		(module) => ({ default: module.Composer }),
		() => ({ default: ComposerUnavailable }),
	),
);

/** Loads the composer chunk in the background, before the first message. */
export function usePreloadComposer(): void {
	useEffect(() => {
		const timer = window.setTimeout(() => {
			// A failure here shows later, as ComposerUnavailable.
			loadComposer().catch(() => {});
		}, 0);
		return () => window.clearTimeout(timer);
	}, []);
}

export function Composer(props: ComposerProps) {
	return (
		<Suspense fallback={null}>
			<LazyComposer {...props} />
		</Suspense>
	);
}
