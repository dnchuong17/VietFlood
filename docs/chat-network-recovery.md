# Chatbot transport recovery

## Incident and diagnosis

The supplied October 27, 2026 trace (`ce32e58b-2d1a-4a74-91e0-f72dad20dbfc`) shows:

- OpenAI action inference failed with `TypeError` / `ETIMEDOUT` after 565 ms, despite a configured 120000 ms stage budget.
- The next OpenAI planning request succeeded.
- Retrieval `/search` failed with another `TypeError` / `ETIMEDOUT` after 1269 ms, and the application correctly returned an unavailable notice rather than inventing evidence.

These are transport failures occurring before the configured stage deadlines, not proof that the model needs a larger generation timeout. The exact production socket/DNS/ingress fault cannot be established from these log lines alone.

The diagnostic OpenAI probe already had transient retry handling, but the runtime OpenAI and retrieval services made each HTTP operation once. This patch closes that recovery gap; it does not claim to repair a persistent production network outage.

## Changes

- `apps/api-gateway/src/chat/chat-http.ts`: at most three attempts, with abortable 250 ms / 500 ms backoff, for an explicit transient transport-code allowlist. Inspect bounded nested causes and aggregate socket errors. Preserve the original caller/stage signal through requests, response-body parsing and backoff.
- `openai-chat.service.ts`: apply recovery to model inference, preserve schema/output validation, and log sanitized stage/retry information.
- `qdrant-knowledge.service.ts`: apply recovery to read-only retrieval/readiness/source requests. Distinguish `connection_timeout` from `retrieval_timeout` (actual deadline expiry).
- `chat-action.service.ts`: preserve pending report fields when extraction fails or returns empty values; accept explicit report requests and labeled or sequential field replies without a working model. Validate all required fields before confirmation and keep report writes behind explicit confirmation.
- Add helper and consumer regression tests. No new dependencies, endpoint/key changes, IP-family forcing or TLS bypass. No report mutation is automatically retried.

Authentication/permission failures, invalid JSON/schema/configuration, TLS failures, unknown error codes, expired deadlines and cancellations are not retried. A permanently unavailable dependency still produces an honest unavailable response.

## Executed verification

From `/Users/macbook/VietFlood`, with `PATH=/opt/homebrew/bin:$PATH`:

- `npm test`: **236 passed, 0 failed, 15 skipped**. Skipped live/opt-in cases are not production acceptance.
- `npm run build:api-gateway`: **passed**.
- A real local HTTP server deliberately closed the first socket; the helper recovered on its second request.
- An additional local HTTP fixture exercised the actual `OpenAIChatService`, `QdrantKnowledgeService` and `RagAnswerService`. It dropped the first action socket and first retrieval socket; both recovered on attempt two and produced an `answered` / `grounded_synthesis` reply with a source citation. Model outputs and corpus content in this test are explicitly synthetic—not live AI or production corpus evidence.
- Other regressions cover nested socket errors, permanent/mixed TLS failures, retry caps, cancellation during backoff, stalled operations, shared deadlines and sanitized logs.

Verification repeated on October 28, 2026: `npm test` reported **236 passed, 15 skipped**, and `npm run build:api-gateway` exited successfully. The tests required permission to run outside the filesystem/network sandbox because local HTTP listeners were blocked with `EPERM` inside it. Docker inspection found no running local daemon, so the deployed gateway could not be checked from this workspace.

Unauthenticated public readiness probes from this workstation received **HTTP 401**: curl in about 366 ms, and three Node fetch probes in 365 / 305 / 146 ms. This establishes public transport reachability from this machine only. It does not establish authenticated retrieval readiness, `/search` success or production-container connectivity.

## Production verification still required

This patch has **not** been committed, pushed or deployed. The live chatbot is not verified repaired.

After deploying the updated gateway, run the existing preflight in the actual gateway container using its already configured environment:

```sh
docker exec vietflood-api-gateway node scripts/check-chat-runtime.js
```

This checks Redis, authenticated RAG readiness/alias/nonempty corpus and a small real model completion. Do not paste secrets into shell arguments or logs, reuse exposed credentials, or run it with unrelated local credentials. No production preflight was executed during this repair.

The checked-in production Compose service defaults to `RAG_SERVICE_URL=http://rag-retrieval:8001`, while the incident log reports a public HTTPS retrieval origin. Inspect the actual deployed configuration and service network before changing it. If both services are on the same Compose network, validate the internal route rather than unnecessarily traversing public ingress. Do not assume a separate deployment has the same service name or network.

If transport failures persist after three attempts, investigate gateway-container DNS answers, IPv4/IPv6 reachability, egress/firewall/proxy settings, public ingress and retrieval readiness. Increasing `OPENAI_REQUEST_TIMEOUT_MS` or `RAG_RETRIEVAL_TIMEOUT_MS` alone does not repair an early socket failure.

Finally, run a non-mutating authenticated chatbot knowledge query and verify a real answer plus source snapshot. Do not use a fixture reply or a greeting as evidence that production retrieval works, and do not submit a live report as a connectivity test.
