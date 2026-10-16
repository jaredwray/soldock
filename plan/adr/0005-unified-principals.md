# ADR-0005: Humans and agents are the same kind of principal

- **Status:** accepted
- **Date:** 2026-10-15
- **Decided in:** plan bootstrap (requirements R3 and R4)

## Context

The brief requires that agents work through MCP **as their own identity** and that the system
work for humans and agents alike. Common patterns fall short. In the "service account" pattern
an agent is a second-class bot without a mailbox. In "OAuth on behalf of a user" the agent is
invisible and borrows a human's rights.

## Decision

- One `principals` table holds kinds `human`, `agent`, `group` and `system`. Humans and agents get
  the same resources: a primary address and mailbox, a My Drive, a `PrincipalDO`, credentials, and
  membership in groups. They can be shared with, mentioned, invited to meetings, assigned comments,
  and given delegated access.
- Each agent has a **sponsor** (an accountable human) and an **agent policy**. The policy sets a
  scope ceiling, outbound mail mode and allowlist, external sends that require approval, rate and
  volume limits, quotas and allowed toolsets. The policy can only narrow what the agent's grants allow.
  Only admins or the sponsor can change it, never the agent.
- Agents authenticate with **their own credentials**: an API key (bearer), or an OAuth
  `client_credentials` client bound to the agent. The token subject is the agent.
- **Delegation is separate from identity.** A human can grant a principal (often an agent) access to
  their mailbox or folders through ordinary resource grants. An MCP client acting for a human
  (authorization code + PKCE) carries `subject = human` and `actor = client`. The audit trail
  records all three: the actor, the subject, and who delegated.
- Agents are **always visibly labelled** in the UI, in mail headers they send (`X-Soldock-Agent`
  and, depending on policy, a footer), in presence cursors and in audit views.

## Consequences

- Every operation's authorization tests run for both kinds and for delegated tokens. The CI
  authorization matrix starts in S02.
- An admin can suspend an agent, which revokes its tokens at once and stops its outbound mail queue.
- Licensing and quota reports count humans and agents separately.

## Alternatives considered

- *Agents as OAuth clients only*: agents could not own a mailbox or files, receive mail or be shared with.
- *Agents as ordinary humans with a flag*: they would lack sponsorship, policy limits and safety
  controls, and that is unsafe for outbound actions.
