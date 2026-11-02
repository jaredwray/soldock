# `api` module

> Status: **started**. Routes come from the operation registry. OpenAPI generation and pagination
> helpers are not built yet. Keep this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | REST adapter: generates Hono routes and the OpenAPI 3.1 document from the operation registry; request validation, error mapping, pagination and idempotency middleware. |
| **Owns** | No data. |
| **Depends on** | `platform`, `identity` (auth). Domain handlers are injected by the composition root (`src/index.ts`); this adapter never imports product domains. |
| **Operations** | Serves every operation under `/api/v1`. |
| **Data inventory** | None (stateless). |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## How a request runs

1. `mountRestApi()` mounts one route for each operation, from its `http.method` and `http.path`.
   `{name}` path segments become path parameters.
2. The route authenticates the request: a bearer API key, or the session cookie.
3. A change (not GET) with the session cookie must have an `Origin` header equal to the origin.
4. The input is the JSON body (or the query string for GET), plus the path parameters. The
   `Idempotency-Key` header fills `idempotency_key` when the operation has that field.
5. The shared invoker (`platform`) checks the caller kind and the scopes, validates the input,
   runs the handler and validates the output.
6. Errors are `application/problem+json` (RFC 9457) with the `code` from the error catalogue.
   A missing or bad credential gets `401` with `WWW-Authenticate: Bearer`.
