import { z } from "./zod.ts";

/**
 * What a call changed on an agent or a service account, for its membership of a team mailbox, a room or a
 * shared drive. The membership says what the agent can do in the resource. The agent also gets the scopes
 * that it needs to use it.
 */
export const AgentAccessChange = z.object({
	principal_id: z.string(),
	/** The scopes that the agent got on its account. They also apply to its own mailbox and drive, and to each room. */
	scopes_added: z.array(z.string()),
});
export type AgentAccessChange = z.infer<typeof AgentAccessChange>;
