# ADR-0002: Run only on Cloudflare, serve everything from one origin

- **Status:** accepted
- **Date:** 2026-10-15
- **Decided in:** plan bootstrap (requirements R1 and R6)

## Context

The brief requires that the system use only Cloudflare resources and that the whole UX live on
one subdomain (for example `dock.jaredwray.com`). Google Workspace spreads its surface across many
hosts, including a separate user-content domain for security.

## Decision

1. **The production runtime depends only on Cloudflare products.** That means Workers, Durable Objects,
   D1, R2, KV, Queues, Workflows, Email Routing and Email Service, Realtime, Workers AI, Vectorize,
   Browser Run, Images, Containers, Secrets, Analytics Engine, Access, Turnstile and Rate Limiting.
   No external databases, SaaS APIs, or servers outside Cloudflare. Development tooling (GitHub,
   npm, CI runners) is not runtime and is allowed. Outbound requests to third parties happen only
   when a user starts them (imports, webhooks they registered).
2. **One origin.** The SPA, `/api`, `/mcp`, `/oauth`, `/.well-known`, `/auth`, `/ws`, `/blob` and
   `/dl` are all served by the `dock` Worker on one hostname. Mail domains are DNS zones with MX
   records pointing to Email Routing, and they have no HTTP surface.
3. **No user content on the origin as active content.** Without a separate user-content domain,
   we treat attacker-controlled bytes as inert. Active types are always served as attachments with
   `CSP: sandbox`. Previews render in sandboxed iframes without `allow-same-origin`. Mail HTML is
   sanitized and sandboxed.
4. **All file transfer goes through the Worker.** R2 presigned URLs work only on the
   `r2.cloudflarestorage.com` host. Uploads use chunked multipart sessions so they stay under the
   per-request body limits of zone plans.

## Consequences

- Some capabilities are limited by Cloudflare: no IMAP or SMTP for desktop clients, and outbound
  mail limits under Email Service. These appear as explicit non-goals and in [risks](../risks.md).
- One Cloudflare account and zone configuration is needed per deployment. `soldock provision`
  (S00.T09) automates it.
- The same-origin decision raises the bar on content security. The S01 security baseline and the S13
  review cover it.

## Alternatives considered

- *A separate user-content subdomain*: it is safer, but it violates R6. We may revisit it as an
  opt-in hardening setting post-v1.
- *An external SMTP relay or TURN provider*: these violate R1.
