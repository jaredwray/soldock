import { currentAccount } from "./account.ts";
import { api } from "./api.ts";
import { base64ToBytes } from "./base64.ts";

const SCOPE = "/chat-push/";
let restore: { account: string | null; done: Promise<void> } | undefined;

export function supportsPush(): boolean {
	return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

const pushScopes = () => new URL(SCOPE, location.origin).href;

function scopeFor(account: string): string {
	return new URL(`${SCOPE}${encodeURIComponent(account)}/`, location.origin).href;
}

async function deviceRegistration(account: string): Promise<ServiceWorkerRegistration | undefined> {
	const scope = scopeFor(account);
	const registration = await navigator.serviceWorker.getRegistration(scope);
	return registration?.scope === scope ? registration : undefined;
}

async function activeWorker(registration: ServiceWorkerRegistration): Promise<void> {
	if (registration.active) return;
	const worker = registration.installing ?? registration.waiting;
	if (!worker) throw new Error("The notification service did not start.");
	await new Promise<void>((resolve, reject) => {
		const changed = () => {
			if (worker.state !== "activated" && worker.state !== "redundant") return;
			worker.removeEventListener("statechange", changed);
			if (worker.state === "activated") resolve();
			else reject(new Error("The notification service did not start."));
		};
		worker.addEventListener("statechange", changed);
		changed();
	});
}

async function registerDevice(account: string, subscription: PushSubscription): Promise<void> {
	const keys = subscription.toJSON().keys;
	if (!keys?.p256dh || !keys.auth) throw new Error("This browser did not provide its push keys.");
	if (currentAccount() !== account) throw new Error("Your session changed.");
	await api.call("chat.subscribe_push", {
		expected_principal_id: account,
		endpoint: subscription.endpoint,
		keys: { p256dh: keys.p256dh, auth: keys.auth },
	});
}

function applicationKey(publicKey: string): Uint8Array<ArrayBuffer> {
	return base64ToBytes(publicKey.replaceAll("-", "+").replaceAll("_", "/"));
}

function matchesKey(subscription: PushSubscription, key: Uint8Array): boolean {
	const buffer = subscription.options.applicationServerKey;
	if (!buffer || key.length !== buffer.byteLength) return false;
	const current = new Uint8Array(buffer);
	return key.every((byte, index) => byte === current[index]);
}

/** Two tabs can notice a new key at the same time. Finish one change before the next tab reads the subscription. */
function changeDevice(account: string, change: () => Promise<void>): Promise<void> {
	return navigator.locks ? navigator.locks.request(scopeFor(account), change) : change();
}

async function bindDevice(account: string, registration: ServiceWorkerRegistration, publicKey: string): Promise<void> {
	await activeWorker(registration);
	const key = applicationKey(publicKey);
	let subscription = await registration.pushManager.getSubscription();
	if (currentAccount() !== account) throw new Error("Your session changed.");
	if (subscription && !matchesKey(subscription, key)) {
		await api.call("chat.unsubscribe_push", { expected_principal_id: account, endpoint: subscription.endpoint });
		await subscription.unsubscribe();
		subscription = null;
	}
	subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
	await registerDevice(account, subscription);
}

/** Ask for permission only from the button of the person. The browser can refuse a request after an await. */
export async function enableDevicePush(account: string, publicKey: string): Promise<void> {
	if ((await Notification.requestPermission()) !== "granted")
		throw new Error("Allow notifications for this site in your browser.");
	await changeDevice(account, async () => {
		if (currentAccount() !== account) throw new Error("Your session changed.");
		const registration = await navigator.serviceWorker.register("/chat-push.js", { scope: scopeFor(account) });
		try {
			await bindDevice(account, registration, publicKey);
			if (restore?.account === account) restore = undefined;
		} catch (error) {
			await removeRegistration(registration);
			throw error;
		}
	});
}

async function removeRegistration(registration: ServiceWorkerRegistration): Promise<void> {
	try {
		for (const notification of await registration.getNotifications()) notification.close();
		const subscription = await registration.pushManager.getSubscription();
		await subscription?.unsubscribe();
	} finally {
		await registration.unregister();
	}
}

export function disableDevicePush(account: string): Promise<void> {
	return changeDevice(account, async () => {
		const registration = await deviceRegistration(account);
		if (!registration) return;
		const subscription = await registration.pushManager.getSubscription();
		if (subscription && currentAccount() === account) {
			await api.call("chat.unsubscribe_push", { expected_principal_id: account, endpoint: subscription.endpoint });
		}
		await removeRegistration(registration);
	});
}

export async function devicePushEnabled(account: string, publicKey: string | null): Promise<boolean> {
	if (!supportsPush() || Notification.permission !== "granted") return false;
	if (restore?.account === account) await restore.done;
	const registration = await deviceRegistration(account);
	const subscription = await registration?.pushManager.getSubscription();
	// An existing device can still opt out while the server has no VAPID configuration.
	return Boolean(subscription && (publicKey === null || matchesKey(subscription, applicationKey(publicKey))));
}

/** Bind the device to the current session. Remove the registrations of previous accounts. */
export function syncPushDevices(account: string | null): Promise<void> {
	const done = restorePushDevices(account);
	restore = { account, done };
	return done;
}

async function restorePushDevices(account: string | null): Promise<void> {
	if (!supportsPush()) return;
	const own = account ? scopeFor(account) : null;
	const registrations = await navigator.serviceWorker.getRegistrations();
	for (const registration of registrations) {
		if (account !== currentAccount()) return;
		if (!registration.scope.startsWith(pushScopes())) continue;
		if (registration.scope !== own) await removeRegistration(registration);
	}
	if (!account || !registrations.some((registration) => registration.scope === own)) return;
	await changeDevice(account, async () => {
		// A different tab can turn push off before this tab gets the lock.
		const registration = await deviceRegistration(account);
		if (!registration || currentAccount() !== account || Notification.permission !== "granted") return;
		const { vapid_public_key } = await api.call("chat.get_notification_settings", {});
		if (vapid_public_key) await bindDevice(account, registration, vapid_public_key);
	});
}
