import type { z } from "zod";
import { directoryOperations } from "./directory.ts";
import { docsOperations } from "./docs.ts";
import { domainOperations } from "./domains.ts";
import { driveOperations } from "./drive.ts";
import { mailOperations } from "./mail.ts";
import type { Operation } from "./operation.ts";
import { sheetsOperations } from "./sheets.ts";
import { teamMailboxOperations } from "./team-mailboxes.ts";

/** Every operation, by name. Adapters and the client are generated from this registry. */
export const operations = {
	...mailOperations,
	...directoryOperations,
	...domainOperations,
	...teamMailboxOperations,
	...driveOperations,
	...docsOperations,
	...sheetsOperations,
} as const;

export type Operations = typeof operations;
export type OperationName = keyof Operations;
export type InputOf<N extends OperationName> = z.input<Operations[N]["input"]>;
export type OutputOf<N extends OperationName> = z.output<Operations[N]["output"]>;

export const operationList: readonly Operation[] = Object.values(operations);
