# `@soldock/contracts`

> Status: **started**. The registry holds the Mail, account and directory operations. Events and
> the SDK build come later.

The operation registry: operation definitions (Zod schemas, scopes, annotations, errors), the error
catalogue, the scope catalogue and the typed client. Shared by `dock`, `web` and `sdk`. Must stay
runtime-agnostic (no Workers, DOM or Node APIs).

| File | What |
| --- | --- |
| `src/operation.ts` | `defineOperation()`: name, summary, description, REST route, scopes, callers, annotations, input and output schemas, errors |
| `src/registry.ts` | `operations`, every operation by name, and the `InputOf` / `OutputOf` types |
| `src/mail.ts`, `src/directory.ts` | The operations of each domain, with their schemas and limits (`MAIL_LIMITS`) |
| `src/errors.ts` | The error catalogue: code → HTTP status and title |
| `src/scopes.ts` | The scope catalogue, and `AGENT_SCOPES`, the most that an agent key can hold |
| `src/domains.ts` | The domain schema and admin operations to list, add, and remove mail domains |
| `src/setup.ts` | The schemas of setup (`/auth/setup`), including the first `mail_domain`. Token verification (`POST /auth/setup/verify`) returns `204`. Setup creates a credential, so it is not an operation |
| `src/signin.ts` | The schemas and limits of sign-in with a one-time code (`/auth/code`, `/auth/session`). Sign-in creates a credential, so it is not an operation |
| `src/client.ts` | `createClient()`: a typed REST client built from each operation's route. The web app uses it |

## Rules

- Each capability is one operation here. The REST route, the MCP tool and the client come from it.
- GET inputs other than path parameters are scalars, because they come from the query string.
- An operation that agents can call needs only scopes in `AGENT_SCOPES`.
- `test/registry.test.ts` checks these rules, and that each schema converts to JSON Schema for MCP.
