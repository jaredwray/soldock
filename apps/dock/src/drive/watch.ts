import type { CallContext } from "../identity/index.ts";
import { OperationError, type ResourceWatcher, type WatcherMap } from "../platform/index.ts";
import { accept, openSpace } from "./access.ts";

/**
 * Drive resources can be read. They have no live feed yet.
 * `open` returns null, so a listen stream leaves the URI out.
 */
async function canReadItem(call: CallContext, vars: Readonly<Record<string, string>>): Promise<boolean> {
	try {
		const opened = await openSpace(call, vars.space_id);
		accept(await opened.space.getItem(opened.ctx, vars.item_id as string));
		return true;
	} catch (error) {
		if (error instanceof OperationError) return false;
		throw error;
	}
}

async function canReadDrive(call: CallContext, vars: Readonly<Record<string, string>>): Promise<boolean> {
	try {
		const opened = await openSpace(call, vars.drive_id);
		accept(opened.space.sharedDrive(opened.ctx));
		return true;
	} catch (error) {
		if (error instanceof OperationError) return false;
		throw error;
	}
}

const itemWatcher: ResourceWatcher<CallContext> = {
	async allowed(call, resources) {
		return Promise.all(resources.map((vars) => canReadItem(call, vars)));
	},
	async open() {
		return null;
	},
};

const spaceWatcher: ResourceWatcher<CallContext> = {
	async allowed(call, resources) {
		return Promise.all(resources.map((vars) => canReadDrive(call, vars)));
	},
	async open() {
		return null;
	},
};

export const driveWatchers: Pick<WatcherMap<CallContext>, "drive.item" | "drive.space"> = {
	"drive.item": itemWatcher,
	"drive.space": spaceWatcher,
};
