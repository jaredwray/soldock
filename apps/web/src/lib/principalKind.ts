import type { Principal } from "@asterra/contracts";

/** The kind of a principal in the directory: a person, an agent or a service account. */
export type PrincipalKind = Principal["kind"];

/**
 * The kind of an author or a member in a product record. A service account is an agent there: Mail,
 * Drive and Chat apply each agent rule to it.
 */
export function actorKind(kind: PrincipalKind): "human" | "agent" {
	return kind === "human" ? "human" : "agent";
}

/** True for an agent and a service account: a principal that is not a person. */
export function isAutomated(kind: PrincipalKind): boolean {
	return kind !== "human";
}

/** The name of each kind, for a label or a chip. */
export const KIND_NAMES: Record<PrincipalKind, string> = {
	human: "Person",
	agent: "Agent",
	service: "Service account",
};

/** The text after a name for a principal that is not a person: "agent" or "service account". Empty for a person. */
export function kindTag(kind: PrincipalKind): string {
	return kind === "human" ? "" : KIND_NAMES[kind].toLowerCase();
}
