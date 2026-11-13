// The operation handlers of each domain, joined. The composition root and the tests use this one map.
import { chatHandlers } from "./chat/index.ts";
import { docsHandlers } from "./docs/index.ts";
import { driveHandlers } from "./drive/index.ts";
import { type CallContext, identityHandlers } from "./identity/index.ts";
import { mailHandlers } from "./mail/index.ts";
import type { HandlerMap } from "./platform/index.ts";
import { sheetsHandlers } from "./sheets/index.ts";

export const handlers: HandlerMap<CallContext> = {
	...identityHandlers,
	...mailHandlers,
	...driveHandlers,
	...docsHandlers,
	...sheetsHandlers,
	...chatHandlers,
};
