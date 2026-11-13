import { type ComponentType, lazy, Suspense } from "react";

// A page that is a separate chunk, so the first load of the app is smaller.

/**
 * The chunk can fail to load: the connection is down, or a deploy removed the files of this version.
 * Then the page asks for a reload, and the rest of the app continues to work.
 */
function PageUnavailable() {
	return (
		<main id="main" className="page" tabIndex={-1}>
			<h1>This page did not load</h1>
			<p role="alert">
				The connection can be down, or a new version of Soldock is available. Reload the page, then try again.
			</p>
			<p>
				<button type="button" className="button button-primary" onClick={() => window.location.reload()}>
					Reload
				</button>
			</p>
		</main>
	);
}

function PageLoading() {
	return (
		<main id="main" className="page" tabIndex={-1}>
			<p className="list-state" role="status">
				<span className="spinner" aria-hidden="true" />
				Loading…
			</p>
		</main>
	);
}

/** A page component from a chunk that loads when the page first shows. */
export function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
	const Page = lazy(() =>
		load().then(
			(component) => ({ default: component }),
			() => ({ default: PageUnavailable as ComponentType<P> }),
		),
	);
	return function LazyPage(props: P) {
		return (
			<Suspense fallback={<PageLoading />}>
				<Page {...props} />
			</Suspense>
		);
	};
}
