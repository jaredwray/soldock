# `ai` module

> Status: **started**. The first layer exists: the AI settings of the organization, the call to Workers
> AI through Cloudflare AI Gateway, the monthly budget and the usage ledger. Inbox auto labels in the
> [mail module](../mail/README.md#auto-labels) are the first feature that uses it. The **AI features**
> switch in the mailbox settings of the web app is the switch of the auto labels of that mailbox. Keep this README
> current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | One place for AI calls: the settings of the organization, the gateway call, the budget stop and the usage that Admin › AI shows. |
| **Owns** | D1 tables `ai_settings` (with the API token of the gateway) and `ai_usage` (migration `0028`). The optional Worker secret `AI_GATEWAY_TOKEN` is the operator's. |
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
| API token | Write-only. `api_token` saves it, and null removes it. Letters, digits, `_` and `-` only, so it cannot break a header |
| Allowed models | Models of `AI_MODELS` in `packages/contracts` only. Workers AI models only, so the AI stays in Cloudflare |
| Monthly budget | USD, from 0.01. The default is 10 |
| Inbox auto labels | On or off, and its model, which must be an allowed model |

`ai.update_settings` applies its change to the newest row and writes with a compare-and-set on
`updated_at`. It reads and applies again when a different write came first, so two changes at the same
time both stay.

To turn on AI, the account ID, the gateway ID and one allowed model must be set. The token is not a
condition: without it, AI makes no calls, the rules of auto labels still apply, and Admin › AI says why.

The API token comes from the settings (`ai_settings.api_token`), else from the Worker secret
`AI_GATEWAY_TOKEN`. A token of the settings wins, because an owner or an admin entered it on purpose. No
answer and no log contains it: an answer says only whether a token exists (`token_configured`) and where
it comes from (`token_source`). A change of the token gets its own audit line, without the token. D1 keeps
the token as it keeps the signing secrets of webhooks. With the Worker secret `ENCRYPTION_KEY`, each write
seals the token (`sealSecret` of [`platform`](../platform/README.md#secrets-at-rest)). Without it, the token
is plaintext.

- A token from before `ENCRYPTION_KEY` stays plaintext and in use. The next write of the settings seals it.
- When a sealed token does not open, the settings act as without a token: `AI_GATEWAY_TOKEN` applies, or
  `not_ready_reason` is `no_token`. A change that does not name the token keeps the sealed token in the row.
- With an `ENCRYPTION_KEY` of fewer than 32 characters, a save of a token fails with `unavailable`.

## The gateway call

`chat()` sends one request to the OpenAI-compatible endpoint of AI Gateway:

- `POST https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/chat/completions`. The host
  is a constant.
- `authorization: Bearer <token>` for Workers AI, and `cf-aig-authorization: Bearer <token>` for an
  authenticated gateway.
- `cf-aig-metadata` with the feature and the mailbox id, so the gateway logs show who used AI. No
  address goes in it.
- `cf-aig-collect-log-payload: false`, so the gateway keeps no request or response body. A prompt of
  auto labels holds mail text. The gateway log still keeps the metadata: the model, the status, the
  tokens, the cost and the duration. `post()` sends the header for each attempt, also for the retry
  without the schema.
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
| AI settings | D1 `ai_settings` (migration `0028`) | One row. It holds the API token of the settings (see the API token row). A directory reset makes a new row with AI off |
| Usage ledger | D1 `ai_usage` (migration `0028`) | One row for each UTC day, feature, model and resource (a mailbox id, or the id of the person who tested). Requests, failures, tokens and the cost in micro-USD. No content. The hourly cron trigger deletes days older than 400 days. A directory reset deletes it |
| API token | D1 `ai_settings.api_token`, or the Worker secret `AI_GATEWAY_TOKEN` | Entered in Admin › AI, or set with `wrangler secret put`. Never in an answer or a log. With `ENCRYPTION_KEY`, the token of the settings is sealed in D1. Without it, the token is plaintext, and a backup of D1 holds it: keep a backup of D1 as a secret. A directory reset deletes it |
| Prompts and answers | Not stored | Asterra stores neither, and each request asks AI Gateway to keep no body (`cf-aig-collect-log-payload: false`). The gateway log keeps the metadata only. The header does not change what a Logpush job of the gateway exports: an operator who turns on Logpush must examine that export separately |

## Safety

- The host of the gateway is fixed, and the ids that make the path pass strict patterns: no setting
  can send a request to a different host.
- Only owners and admins change the settings or test the connection. Agents and service accounts cannot
  hold `directory.write`, and the operations refuse them, so no agent can change the AI policy or the
  budget.
- The token is write-only: no answer and no log contains it. Only owners and admins can save or remove it.
- An owner or an admin can set the account ID, the gateway ID and the token in one change. Thus an admin
  credential can send the prompts of auto labels, with mail text, to a different Cloudflare account. Treat
  admin credentials as you treat the mail. Each change of the token gets an audit line.
- The budget bounds what inbound mail can cost: a hostile sender can send much mail, but the calls stop
  at the budget, and rules decide most bulk mail with no call.

## Not built yet

- Providers other than Workers AI through AI Gateway. They are outside Cloudflare, so the golden rule
  keeps them out for now
- A reservation of budget before a call, and alerts to owners near the budget
- The analytics of AI Gateway in Admin › AI, to compare with the estimate
- More features: summaries, drafts and search with AI
