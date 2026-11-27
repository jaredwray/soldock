// The name of each queue is `<prefix>-<suffix>`. The prefix is the instance: `soldock` for an instance
// from before the operator CLI, and `asterra-<name>` for each instance that `npx asterra install` makes.
// One Cloudflare account can hold more than one instance, so the Worker knows only the suffix.

/** True when the queue `name` of a batch is the queue with this suffix, for any instance prefix. */
export function isQueue(name: string, suffix: string): boolean {
	return name.endsWith(`-${suffix}`);
}
