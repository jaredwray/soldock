// The page owns its title. The chat count applies to each page in the signed-in tab.
let title = "Asterra";
let unread = 0;

function render(): void {
	document.title = unread > 0 ? `(${unread}) ${title}` : title;
}

export function setPageTitle(value: string): void {
	title = value;
	render();
}

export function setChatUnread(count: number): void {
	unread = count;
	render();
	if (count === 0) void navigator.clearAppBadge?.().catch(() => {});
	else void navigator.setAppBadge?.(count).catch(() => {});
}
