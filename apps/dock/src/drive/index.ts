// Public surface of the drive module. Other modules import from here, never from its files.
export {
	accept,
	actorOf,
	auditOk,
	idempotencyOf,
	type OpenSpace,
	openSpace,
	readDocument,
	toOneItem,
	writeDocument,
} from "./access.ts";
export { driveHandlers } from "./handlers.ts";
export { DriveSpaceDO, type ItemRecord } from "./space.ts";
