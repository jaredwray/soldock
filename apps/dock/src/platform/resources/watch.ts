import type { ResourceName } from "@soldock/contracts";

/** What a change feed tells its listener. */
export interface WatchListener {
	/** The resource changed, as the `updates` text of its definition says. */
	change(): void;
	/** The feed stopped by itself, for example because its object restarted. */
	end(): void;
}

/** An open change feed. */
export interface Watch {
	close(): void;
}

/**
 * The change feed of one resource kind. A domain module implements it, and the MCP adapter uses it
 * for `subscriptions/listen`. `C` is the call context that the composition root builds.
 */
export interface ResourceWatcher<C> {
	/**
	 * For each resource (its URI variables), true when the caller can use it now. A resource that does
	 * not exist gets false too, so the answer tells nothing about other mailboxes or items. A stream asks
	 * with all of its resources of this kind in one call, so the check can use one query. It asks
	 * before it opens the feeds, and again from time to time.
	 */
	allowed(call: C, resources: readonly Readonly<Record<string, string>>[]): Promise<boolean[]>;
	/** Opens a change feed for one resource. Call it only for a resource that `allowed` accepted. */
	open(call: C, vars: Readonly<Record<string, string>>, listener: WatchListener): Promise<Watch>;
}

/** One change feed for each resource kind of the registry. */
export type WatcherMap<C> = { [N in ResourceName]: ResourceWatcher<C> };
