# `ai` module

> Status: **started**. The first layer exists: the AI settings of the organization, the call to Workers
> AI through Cloudflare AI Gateway, the monthly budget and the usage ledger. Inbox auto labels in the
> [mail module](../mail/README.md#auto-labels) are the first feature that uses it. Keep this README
> current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | One place for AI calls: the settings of the organization, the gateway call, the budget stop and the usage that Admin › AI shows. |
| **Owns** | D1 tables `ai_settings` and `ai_usage` (migration `0027`). The Worker secret `AI_GATEWAY_TOKEN` is the operator's. |
| **Depends on** | `platform`, `identity`. |
| **Operations** | `ai.get_settings`, `ai.update_settings`, `ai.test_connection`, `ai.get_usage` |
| **Data inventory** | See [Data inventory](#data-inventory). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `settings.ts` | Reads and writes the one row of `ai_settings`, checks a change, and tells whether AI can make calls |
| `gateway.ts` | `chat()`: the checks before a call, the call to AI Gateway, and the record in the ledger |
| `usage.ts` | The ledger: the cost of the month, the upsert of one call, the report of a month, and the cleanup |
| `handlers.ts` | The four `ai.*` handlers |

## Settings

Owners and admins read and change the settings in **Admin › AI**. People without the role, agents and
service accounts cannot call the operations: they name `human` only, and each handler checks the role.
The read operations audit each refusal.

| Setting | Notes |
| --- | --- |
| On or off | Off: no feature calls the gateway |
| Account ID and gateway ID | The Cloudflare account (32 hexadecimal characters) and the AI Gateway (lowercase letters, digits and hyphens). Strict patterns keep them from changing the URL |
| Allowed models | Models of `AI_MODELS` in `packages/contracts` only. Workers AI models only, so the AI stays in Cloudflare |
| Monthly budget | USD, from 0.01. The default is 10 |
| Inbox auto labels | On or off, and its model, which must be an allowed model |

`ai.update_settings` applies its change to the newest row and writes with a compare-and-set on
`updated_at`. It reads and applies again when a different write came first, so two changes at the same
time both stay.

To turn on AI, the account ID, the gateway ID and one allowed model must be set. The token is not a
condition: without it, AI makes no calls, the rules of auto labels still apply, and Admin › AI says why.

The token is the Worker secret `AI_GATEWAY_TOKEN`. It is never in D1, in an answer or in a log. An
answer says only whether it exists (`token_configured`).

## The gateway call

`chat()` sends one request to the OpenAI-compatible endpoint of AI Gateway:

- `POST https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/chat/completions`. The host
  is a constant.
- `authorization: Bearer <token>` for Workers AI, and `cf-aig-authorization: Bearer <token>` for an
  authenticated gateway.
- `cf-aig-metadata` with the feature and the mailbox id, so the gateway logs show who used AI. No
  address goes in it.
- The body names the model as `workers-ai/<model id>`, with `temperature: 0`. A model that accepts a
  JSON schema gets `response_format`. When the gateway refuses the schema with `400`, the call goes one
  more time without it. The ledger counts the refused request as a failure.
- A model with `reasoning: true` in `AI_MODELS` reasons before it answers, and the reasoning uses tokens
  of the answer. `chat()` gives such a model a limit of 1,200 tokens or more for a feature call, so the answer is not
  empty. A connection test does not stop at the budget, so it gets 64 tokens, and it accepts an answer
  with no text.
- The answer is `choices[0].message.content`, and `usage` gives the tokens. Without `usage`, the tokens
  are estimated at 4 characters each.
- The timeout is 20 seconds. A timeout, a network error, `408`, `429` and `5xx` can be tried again. A
  request that did not reach the gateway is a failure with no status, and the ledger counts it.

Before each call, except a connection test, `chat()` checks that AI and the feature are on, that the
gateway, the token and an allowed model are set, and that the month has budget left. A call that does
not pass makes no request.

Each call that goes out adds one row, or adds to one row, of the ledger. One log line has the feature,
the model, the mailbox, the status, the time, the tokens and the cost. The prompt, the answer and the
token never go in a log.

## Budget and cost

- The cost of a call is `input tokens × input price + output tokens × output price`, with the prices
  for 1 million tokens in `AI_MODELS`. The ledger keeps millionths of a USD.
- Before a call, `chat()` reads the sum of the current UTC month. At the budget or more, no call goes
  out until the next month or a higher budget.
- No reservation is made. Calls that run at the same time can pass the budget by a small amount: the
  queue of auto labels runs at most 4 consumers, and one call costs about USD 0.0005.
- A crash between a call and its record loses that record.
- The cost is an estimate from the published Workers AI prices of `AI_PRICE_DATE`. The AI Gateway
  dashboard in Cloudflare is the source for billing. Update `AI_MODELS` and `AI_PRICE_DATE` when the
  prices change.

## Usage report

`ai.get_usage` returns one UTC month: the cost against the budget, the requests, the failures and the
tokens, each day (with zeros), each feature, each model, and the 10 mailboxes with the highest cost.
A connection test counts for the person who ran it. A deleted mailbox shows as `unknown`.

## Data inventory

| State | Where | Notes |
| --- | --- | --- |
| AI settings | D1 `ai_settings` (migration `0027`) | One row. No secret. A directory reset makes a new row with AI off |
| Usage ledger | D1 `ai_usage` (migration `0027`) | One row for each UTC day, feature, model and resource (a mailbox id, or the id of the person who tested). Requests, failures, tokens and the cost in micro-USD. No content. The hourly cron trigger deletes days older than 400 days. A directory reset deletes it |
| API token | Worker secret `AI_GATEWAY_TOKEN` | Set with `wrangler secret put`. Not in a backup of Asterra |
| Prompts and answers | AI Gateway logs, in the Cloudflare account | Asterra stores neither. The gateway can keep logs of each request, with the mail text of auto labels. Turn off log collection in the gateway if you do not want this |

## Safety

- The host of the gateway is fixed, and the ids that make the path pass strict patterns: no setting
  can send a request to a different host.
- Only owners and admins change the settings or test the connection. Agents and service accounts cannot
  hold `directory.write`, and the operations refuse them, so no agent can change the AI policy or the
  budget.
- The token is a Worker secret only.
- The budget bounds what inbound mail can cost: a hostile sender can send much mail, but the calls stop
  at the budget, and rules decide most bulk mail with no call.

## Not built yet

- Providers other than Workers AI through AI Gateway. They are outside Cloudflare, so the golden rule
  keeps them out for now
- A reservation of budget before a call, and alerts to owners near the budget
- The analytics of AI Gateway in Admin › AI, to compare with the estimate
- More features: summaries, drafts and search with AI
