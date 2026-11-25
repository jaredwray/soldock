import { type ComponentType, lazy, Suspense, useEffect } from "react";
import { newVersionAvailable } from "./newVersion.ts";

// A page that is a separate chunk, so the first load of the app is smaller.

/**
 * The chunk can fail to load: the connection is down, or a deploy removed the files of this version.
 * When the server has no new version, the page asks for a reload, and the rest of the app continues to work.
 */
function PageUnavailable() {
	return (
		<main id="main" className="page" tabIndex={-1}>
			<h1>This page did not load</h1>
			<p role="alert">
				The connection can be down, or a new version of Asterra is available. Reload the page, then try again.
			</p>
			<p>
				<button type="button" className="button button-primary" onClick={() => window.location.reload()}>
					Reload
				</button>
			</p>
		</main>
	);
}

/** The page while a chunk loads, or while the shell finds the path to open. */
export function PageLoading() {
	return (
		<main id="main" className="page" tabIndex={-1}>
			<p className="list-state" role="status">
				<span className="spinner" aria-hidden="true" />
				Loading…
			</p>
		</main>
	);
}

/**
 * The page of a chunk that a deploy removed. It reloads the page into the new version when it shows. A person
 * who left the page before the version check ended does not see it, so a draft on a different page stays.
 */
function ReloadForNewVersion() {
	useEffect(() => {
		window.location.reload();
	}, []);
	return <PageLoading />;
}

/** The entry script of this page, as index.html names it. */
function currentEntryScript(): string | null {
	return document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src") ?? null;
}

/**
 * After a chunk did not load. When the server has a new version, the deploy removed the chunk, so the page
 * reloads one time. The reload gets the new version, so it does not reload again. Otherwise the page shows
 * PageUnavailable.
 */
async function afterLoadFailure<P>(): Promise<{ default: ComponentType<P> }> {
	const current = currentEntryScript();
	const page = current !== null && (await newVersionAvailable(current)) ? ReloadForNewVersion : PageUnavailable;
	return { default: page as ComponentType<P> };
}

/** A page component from a chunk that loads when the page first shows. */
export function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
	const Page = lazy(() =>
		load().then(
			(component) => ({ default: component }),
			() => afterLoadFailure<P>(),
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
