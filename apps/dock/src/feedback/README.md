# `feedback` module

> Status: **started**. The first layer exists: the settings in Admin › General, the Feedback button of the web
> app, attachments (screenshots, screen recordings and image files), and a public GitHub issue for each report.
> Keep this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | A person reports a bug or sends an idea from the web app. Each report becomes a public issue in the GitHub repository that an owner or an admin chose. |
| **Owns** | D1 tables `feedback_settings` (with the GitHub token), `feedback_reports` and `feedback_attachments` (migration `0042`). R2 `BLOBS` keys `feedback/<attachment id>`. |
| **Depends on** | `platform`, `identity`. |
| **Operations** | `feedback.get_status`, `feedback.get_settings`, `feedback.update_settings`, `feedback.upload_attachment`, `feedback.delete_attachment`, `feedback.submit` |
| **Data inventory** | See [Data inventory](#data-inventory). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `settings.ts` | Reads and writes the one row of `feedback_settings`, seals the token, and tells whether feedback is ready |
| `github.ts` | `createIssue()`: the one outbound call, `POST https://api.github.com/repos/{owner}/{repo}/issues` |
| `attachments.ts` | The upload, the check of the type, the public address `/dl/feedback/…`, the removal and the cleanup |
| `handlers.ts` | The six `feedback.*` handlers, the limits and the idempotency of a report |

## Off by default

Feedback is off in a new organization. When it is off, the web app shows no Feedback button, and the server
refuses `feedback.upload_attachment` and `feedback.submit` with `forbidden`. When it is on with no token that
opens, the server refuses them with `unavailable`. The web app shows the button only when `feedback.get_status`
returns `can_submit: true`.

## Settings

Owners and admins read and change the settings in **Admin › General**. People without the role, agents and
service accounts cannot call the operations: they name `human` only, and each handler checks the role. The
operations audit each refusal.

| Setting | Notes |
| --- | --- |
| On or off | Off by default |
| Repository owner and name | The default is `jaredwray/soldock`, the Asterra project. Strict patterns keep them from changing the host or the path of the request |
| GitHub token | Write-only. `github_token` saves it, and null removes it. Letters, digits and `_` only, so it cannot break a header |

`feedback.update_settings` writes with a compare-and-set on `updated_at`, so two changes at the same time both
stay. With the Worker secret `ENCRYPTION_KEY`, each write seals the token (purpose
`feedback_settings.github_token`, see [`platform`](../platform/README.md#secrets-at-rest)). No answer, log or audit
line holds the token. A change of the token gets its own audit line.

## Why an outbound call is allowed

The golden rules allow no external runtime services. Feedback does not break that rule:

- Asterra does not depend on GitHub. Each product works when GitHub is down or feedback is off.
- The call is optional and off by default. An owner or an admin turns it on and supplies the token.
- The host is a constant. Webhooks and link previews are the same kind of optional outbound call.

## A report

`feedback.submit` takes the kind (`bug` or `idea`), a title, a description, attachments, the identity choices,
and the context of the page. The server builds the issue with `buildFeedbackIssue` of `packages/contracts`. The web
app uses the same function for its preview, so the person sees the exact text before they send it.

The table has the parts in the order of the issue. The **Reporter** table of the server facts is before the text
of the person, so the text cannot put a false table above the real one.

| Part of the issue | Source |
| --- | --- |
| Title | `[Bug]` or `[Idea]`, then the title. The label is `bug` or `enhancement` |
| Name | The display name, only when `include.name` is true |
| Email | The address, only when `include.email` is true. The web app sets it off by default |
| Role, account kind, instance host, report id | Always. The server takes them from the caller and the origin, never from the input |
| Text | The description, with each mention broken (see below) |
| Attachments | An image shows in the issue. A recording is a link, because GitHub does not show a video from a different host |
| Asterra version, page kind, browser | From the web app. The page is a kind such as `mail` or `admin/general`, never an id or a query string |

`breakMentions` puts a zero-width space after each `@` that a letter or a digit follows, so a report cannot notify
a GitHub user or a team. Only a letter or a digit before the `@` keeps it, as in `ada@example.com`. A backtick or
a `_` before the `@` does not keep it. An HTML entity of `@` (`&#64;`, `&#x40;`, `&commat;`) becomes plain text.
The title, the text and each table cell go through the function.

The issue never holds the principal id. The report id (`fbr_…`) lets an admin find the person in
`feedback_reports`.

- **Callers.** Only a person can send a report or upload an attachment (`callers: ["human"]`, scope
  `feedback.write`). An agent reads untrusted mail, and a public issue would let a prompt injection publish data.
  A key of a person without `feedback.write` cannot send.
- **Limits.** One person can send 5 reports in one hour and 20 in one day. The organization can send 200 in one
  day. Each report row counts: `pending`, `sent` and `failed`. A failed report also made a request to GitHub, so
  it gives no free try. Over a limit, the answer is `rate_limited`. The limits are conditions of the one statement
  that writes the row, so requests at the same time cannot pass them. A report with a bad attachment makes no row.
- **Idempotency.** The server writes the report row as `pending` before the call to GitHub, then `sent` or
  `failed`. The same `idempotency_key` returns the stored issue after `sent`, and tries again after `failed`. The
  new try gets the current time, so it counts in the current hour and day.
  - One key makes at most 3 requests to GitHub (`attemptsPerReport`). After 3 failures, the same key gets
    `rate_limited`, and the person discards the draft. Thus a GitHub that fails cannot get requests with no end.
  - The row becomes `failed` only when GitHub made no issue.
  - After GitHub made the issue, one D1 batch writes `sent` and puts the attachments in the report. The batch
    runs one more time after an error.
  - A `pending` row never tries again, because its issue is possibly on GitHub. The same key gets `conflict`. The
    text tells the person to examine the issues of the repository, or to discard the draft.
  - The issue body has the marker `<!-- asterra-feedback: fbr_… -->`, so a person can find the issue of a report.
- **GitHub errors.** The timeout is 10 seconds, and redirects are not followed. Each failure gives `unavailable`
  with a short text. No log line holds the answer of GitHub, the token or the text of the report.

## Attachments

`feedback.upload_attachment` takes base64 content, at most 10 MiB. The server reads the type from the bytes
(`sniffType`). It accepts PNG, JPEG and WebP images, and WebM and MP4 videos. Each other type gets `invalid`. An
image must also pass `readImageInfo`, with at most 16,384 pixels on a side and 64 million pixels.

Each attachment has a public address: `GET|HEAD /dl/feedback/<attachment id>/<token>`.

- The address works with no sign-in, because each reader of the public issue must open it.
- The token is 32 random bytes in base64url. D1 keeps only its SHA-256, and the check is in constant time.
- A wrong id, a wrong token and a row with no bytes in R2 get the same `404`.
- The answer comes from `downloadResponse`: the type that the server found, `nosniff`, the sandbox policy of each
  download, and `private, no-store`. A removal applies at once. GitHub can keep a copy of an image in its cache
  for some time.
- The address names the host of the instance. An instance behind Cloudflare Access gives links that the
  maintainers cannot open.

A person can have at most 10 attachments that no report holds. The upload writes the D1 row first, with the
limit as a condition of the statement, and then puts the bytes in R2. Thus uploads at the same time cannot pass
the limit. If R2 fails, the upload removes the row. One report has at most 5 attachments, and each one
must belong to the person and be in no report yet. The person removes an attachment with
`feedback.delete_attachment`. An owner or an admin can remove each attachment. The answer is `deleted: false` for
an attachment that does not exist or that the caller cannot remove.

## Cleanup

The hourly cron (`runScheduled`) calls `pruneFeedback`:

- An attachment that no report holds goes after 24 hours.
- An attachment of a sent report goes after 180 days.
- A report row goes after 180 days.
- One run removes at most 500 attachments. The bytes go from R2 first, then the rows, with the same age condition.
  If the removal of the rows fails, the next run finds them again, and their addresses already answer `404`.
- A report cannot use an attachment in the last hour before its removal. Thus the cron never removes the bytes of
  an attachment that a report is about to hold.

A directory reset drops the three tables. The bytes of the old attachments stay in R2 with no row, so their
addresses stop at once.

## Data inventory

| State | Where | Notes |
| --- | --- | --- |
| Feedback settings | D1 `feedback_settings` (migration `0042`) | One row: on or off, the repository, the GitHub token (sealed with `ENCRYPTION_KEY`). A directory reset makes a new row with feedback off |
| Reports | D1 `feedback_reports` | The person, the kind, the state, the issue number and address, the idempotency key, the number of tries. Not the title or the text: GitHub holds them. Removed after 180 days |
| Attachments | D1 `feedback_attachments` and R2 `BLOBS` `feedback/<attachment id>` | The person, the report, the SHA-256 of the token, the type, the size and the pixels. Removed after 24 hours without a report, or 180 days in a report |
