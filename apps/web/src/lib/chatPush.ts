import { currentAccount } from "./account.ts";
import { api } from "./api.ts";
import { base64ToBytes } from "./base64.ts";

const SCOPE = "/chat-push/";

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

/** Ask for permission only from the button of the person. The browser can refuse a request after an await. */
export async function enableDevicePush(account: string, publicKey: string): Promise<void> {
	if ((await Notification.requestPermission()) !== "granted")
		throw new Error("Allow notifications for this site in your browser.");
	if (currentAccount() !== account) return;
	const registration = await navigator.serviceWorker.register("/chat-push.js", { scope: scopeFor(account) });
	try {
		await activeWorker(registration);
		const key = base64ToBytes(publicKey.replaceAll("-", "+").replaceAll("_", "/"));
		let subscription = await registration.pushManager.getSubscription();
		const existingKey = subscription?.options.applicationServerKey;
		const currentKey = existingKey ? new Uint8Array(existingKey) : null;
		if (
			subscription &&
			(!currentKey || key.length !== currentKey.length || !key.every((byte, index) => byte === currentKey[index]))
		) {
			await subscription.unsubscribe();
			subscription = null;
		}
		subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
		await registerDevice(account, subscription);
	} catch (error) {
		await removeRegistration(registration);
		throw error;
	}
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

export async function disableDevicePush(account: string): Promise<void> {
	const registration = await deviceRegistration(account);
	if (!registration) return;
	const subscription = await registration.pushManager.getSubscription();
	if (subscription && currentAccount() === account) {
		await api.call("chat.unsubscribe_push", { expected_principal_id: account, endpoint: subscription.endpoint });
	}
	await removeRegistration(registration);
}

export async function devicePushEnabled(account: string): Promise<boolean> {
	if (!supportsPush()) return false;
	const registration = await deviceRegistration(account);
	return Boolean(await registration?.pushManager.getSubscription());
}

/** Bind the device to the current session. Remove the registrations of previous accounts. */
export async function syncPushDevices(account: string | null): Promise<void> {
	if (!supportsPush()) return;
	const own = account ? scopeFor(account) : null;
	const registrations = await navigator.serviceWorker.getRegistrations();
	for (const registration of registrations) {
		if (account !== currentAccount()) return;
		if (!registration.scope.startsWith(pushScopes())) continue;
		if (account && registration.scope === own) {
			const subscription = await registration.pushManager.getSubscription();
			if (subscription) await registerDevice(account, subscription);
		} else {
			await removeRegistration(registration);
		}
	}
}
