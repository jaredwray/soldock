import type { z } from "zod";
import { aiOperations } from "./ai.ts";
import { chatOperations } from "./chat.ts";
import { chatExtraOperations } from "./chat-extras.ts";
import { chatNotificationOperations } from "./chat-notifications.ts";
import { directoryOperations } from "./directory.ts";
import { docsOperations } from "./docs.ts";
import { domainOperations } from "./domains.ts";
import { driveOperations } from "./drive.ts";
import { mailOperations } from "./mail.ts";
import { oauthOperations } from "./oauth.ts";
import type { Operation } from "./operation.ts";
import { sheetsOperations } from "./sheets.ts";
import { teamMailboxOperations } from "./team-mailboxes.ts";
import { webhookOperations } from "./webhooks.ts";

/** Every operation, by name. Adapters and the client are generated from this registry. */
export const operations = {
	...mailOperations,
	...directoryOperations,
	...domainOperations,
	...teamMailboxOperations,
	...driveOperations,
	...docsOperations,
	...sheetsOperations,
	...chatOperations,
	...chatExtraOperations,
	...chatNotificationOperations,
	...oauthOperations,
	...webhookOperations,
	...aiOperations,
} as const;

export type Operations = typeof operations;
export type OperationName = keyof Operations;
export type InputOf<N extends OperationName> = z.input<Operations[N]["input"]>;
export type OutputOf<N extends OperationName> = z.output<Operations[N]["output"]>;

export const operationList: readonly Operation[] = Object.values(operations);
