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
	 * Opens a change feed for the resource with these URI variables. Returns null when the caller
	 * cannot use the resource. The answer is the same for a resource that does not exist, so it
	 * tells nothing about other mailboxes or items.
	 */
	open(call: C, vars: Readonly<Record<string, string>>, listener: WatchListener): Promise<Watch | null>;
	/** True while the caller can still use the resource. A long-lived stream asks again from time to time. */
	allowed(call: C, vars: Readonly<Record<string, string>>): Promise<boolean>;
}

/** One change feed for each resource kind of the registry. */
export type WatcherMap<C> = { [N in ResourceName]: ResourceWatcher<C> };
