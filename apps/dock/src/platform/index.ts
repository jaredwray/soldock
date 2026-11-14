// Public surface of the platform module. Other modules import from here, never from its files.
export {
	base64ToBytes,
	base64UrlEncode,
	bytesToBase64,
	randomToken,
	sameSecret,
	sha256Hex,
} from "./crypto/crypto.ts";
export { MAX_REQUEST_BYTES, readBodyText } from "./http/body.ts";
export { PROBLEM_CONTENT_TYPE, type ProblemDetails, problemResponse } from "./http/problem.ts";
export { REQUEST_ID_HEADER, type RequestIdVariables, requestId } from "./http/request-id.ts";
export { newId } from "./ids/ids.ts";
export { audit, log } from "./log/log.ts";
export { OperationError } from "./operations/errors.ts";
export { type AnyHandler, type Caller, type HandlerMap, invokeOperation } from "./operations/invoke.ts";
export type { ResourceWatcher, Watch, WatcherMap, WatchListener } from "./resources/watch.ts";
