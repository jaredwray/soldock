import type { ResourceName } from "@asterra/contracts";

/**
 * The facts of one change of a resource: ids, a reason, a version. They let a client decide before a
 * read. They never have content: no mail, no message text and no file content.
 */
export type ChangeFacts = Readonly<Record<string, string | number | null>>;

/** What a change feed tells its listener. */
export interface WatchListener {
	/**
	 * The resource changed, as the `updates` text of its definition says. A feed that knows the facts of
	 * the change gives them. A feed of a resource whose read has all that a client needs gives none.
	 */
	change(facts?: ChangeFacts): void;
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
	/**
	 * Opens a change feed for one resource. Call it only for a resource that `allowed` accepted. It
	 * returns null when the resource refuses the caller at that time: `allowed` can use a copy that is a
	 * moment behind. The stream then leaves the resource out, as for a resource that `allowed` refused.
	 */
	open(call: C, vars: Readonly<Record<string, string>>, listener: WatchListener): Promise<Watch | null>;
}

/** One change feed for each resource kind of the registry. */
export type WatcherMap<C> = { [N in ResourceName]: ResourceWatcher<C> };
