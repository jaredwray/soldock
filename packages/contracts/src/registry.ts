import type { z } from "zod";
import { directoryOperations } from "./directory.ts";
import { domainOperations } from "./domains.ts";
import { mailOperations } from "./mail.ts";
import type { Operation } from "./operation.ts";

/** Every operation, by name. Adapters and the client are generated from this registry. */
export const operations = { ...mailOperations, ...directoryOperations, ...domainOperations } as const;

export type Operations = typeof operations;
export type OperationName = keyof Operations;
export type InputOf<N extends OperationName> = z.input<Operations[N]["input"]>;
export type OutputOf<N extends OperationName> = z.output<Operations[N]["output"]>;

export const operationList: readonly Operation[] = Object.values(operations);
