# OpenAI deployment

VietFlood uses the OpenAI-compatible cheapkeyai.shop API with `gpt-4.1-nano-2025-04-14` for intent planning, grounded answer synthesis, and report-action extraction. The existing Python retrieval service and approved Qdrant collection remain the only source of flood knowledge; the model does not replace retrieval or role checks.

## Local setup

Keep the API key in the ignored root `.env` file or another local secret manager. Never commit it or put it in frontend configuration.

```dotenv
OPENAI_API_KEY=<OpenAI API key>
OPENAI_BASE_URL=https://cheapkeyai.shop/v1
OPENAI_CHAT_MODEL=gpt-4.1-nano-2025-04-14
OPENAI_REQUEST_TIMEOUT_MS=120000
RAG_REQUEST_TIMEOUT_MS=300000
RAG_RETRIEVAL_TIMEOUT_MS=90000
```

Run the Nest API gateway as usual. It loads `.env` through `ConfigModule`; a successful build does not make a live model request. Chat requests send the user message and selected retrieved passages to the configured OpenAI endpoint.

## Compose

Set the same variables in the Compose environment file, then run:

```sh
docker compose up -d --build
# Published images:
docker compose -f docker-compose.prod.yml up -d
```

Both Compose files pass the key to the API gateway for chat and the private retrieval service for query embeddings. Set `EMBEDDING_MODEL=text-embedding-3-small` and `EMBEDDING_DIMENSIONS=1536` for retrieval. Ollama containers and model downloads are not needed. The gateway still depends on the retrieval, auth, and report services.

## Jenkins deployment

Add `OPENAI_API_KEY` to the protected `/opt/env/vietflood.env` on the Jenkins agent. Set `OPENAI_BASE_URL`, `OPENAI_CHAT_MODEL`, and timeout values there as needed. The pipeline checks Redis and retrieval readiness, then sends a small static JSON probe to the configured OpenAI chat model before replacing the running backend. This verifies network access, key permissions, model access, and JSON output. It consumes a small amount of API usage and prints only safe status/model/timing metadata. Failures leave the existing backend running.

Set `QDRANT_CHAT_COLLECTION=flood_kb_active` in that protected file. This is the approved active alias, not its versioned physical collection (for example, `flood_kb_active_20261012170418_13a14650`). The preflight compares it with the retrieval service's reported `alias`; a mismatch stops deployment and reports `expectedAlias`, `reportedAlias`, `reportedStatus`, and `pointCount`. Jenkins explicitly passes the shell-loaded alias, RAG endpoint/token and OpenAI key into its check and backend containers so quoted env-file values are handled consistently.

The Jenkinsfile and code must both be on the branch Jenkins checks out. Editing the local `.env`, adding an OpenAI key to an existing Gemini image, or restarting that image does not change its provider. Build and deploy the updated source. Confirm startup logs say `OpenAI chatbot configuration ready` and model-stage logs include `provider=openai`.

For a container managed manually in Portainer, recreate the backend with the newly built image and the same OpenAI variables. Keep Redis and RabbitMQ on the backend's Docker network and use their container names or network aliases as hosts.

## Reference: IU LibBuddy

The reference service's `src/services/legacy-genai-client.service.ts` uses Bearer authentication, `/chat/completions`, `gpt-4o-mini`, and a 60-second HTTP timeout. These match the request shape used by VietFlood; VietFlood keeps its configurable 120-second model-stage deadline and 300-second total RAG deadline.

LibBuddy hardcodes `https://v98store.com/v1` for both chat and embeddings. VietFlood uses the user-selected `https://cheapkeyai.shop/v1` endpoint with a key issued by that provider. No reference-project credentials are copied.

LibBuddy's `OPENAI_MODEL` default in `src/utils/config.ts` is an embedding model (`text-embedding-3-small`). VietFlood uses `OPENAI_CHAT_MODEL` for chat. Its retrieval service uses `text-embedding-3-small` for both documents and queries. The previous E5 index must be replaced through a validated candidate; see the RAG repository’s `PIPELINE_README.md` for manual cutover and rollback.

GPT-4.1 nano requests omit `temperature` and `reasoning_effort`, then set `max_completion_tokens` to 2048 for chat stages. The single output retry doubles this limit; the deployment probe uses 1024.

VietFlood requests JSON object mode and validates each response against its local AJV schema, preserving optional action fields. This follows the distinction between JSON mode and schema-constrained output described in the [official OpenAI documentation](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat).

## Check the configured provider

With Node 20 or later and the root `.env` configured:

```sh
npm run check:openai
```

This sends the same small static probe as Jenkins and can incur API usage. A successful result reports `stage=openai`, `status=ready`, and the configured model. Authentication, permission, model/endpoint, quota/rate-limit, malformed output, and timeout errors stop the check without printing the key or provider response body. It does not test retrieval or the complete chatbot conversation.

The probe makes up to three connection attempts, waiting 500 ms and 1000 ms
between temporary transport failures, within one shared request deadline.
Authentication, quota, HTTP errors, invalid output, and certificate failures
are not retried. Success includes the number of `attempts` used.

Connection failures include a safe `reason`, `errorType`, `errorCode`, and
`errorCodes` (including nested socket errors), rather than just `TypeError`:

| Reason | Check on the Jenkins agent / backend Docker network |
| --- | --- |
| `openai_dns_error` | DNS resolution for the hostname in `OPENAI_BASE_URL`; `EAI_AGAIN` indicates a temporary resolver failure. |
| `openai_connection_refused` / `openai_connection_reset` | Outbound HTTPS access, proxy/firewall rules, and provider connectivity. |
| `openai_network_unreachable` | Container routing and outbound IPv4/IPv6 connectivity. |
| `openai_connection_timeout` / `openai_timeout` | Outbound connectivity and the configured request deadline. |
| `openai_tls_error` | Agent time, the provider certificate chain/hostname, and any required trusted proxy CA. Preserve TLS verification. |

No raw driver message, stack trace, authorization header, or provider response
body is printed. A persistent failure still stops deployment before the old
backend is stopped. These checks run against the configured compatible
provider; a successful check on a developer machine does not establish
connectivity from the Jenkins Docker network.

For HTTP 429, logs include only recognized OpenAI error codes. `insufficient_quota`, credit-balance and spend-limit errors require checking the account's credits or limits; increasing request timeout does not restore access. `rate_limit_exceeded` and `slow_down` indicate request pacing is needed. See the [official OpenAI error guide](https://developers.openai.com/api/docs/guides/error-codes).

Provider regression tests use mocked HTTP responses, not a paid API:

```sh
npm test -- apps/api-gateway/src/chat/openai-chat.service.spec.ts scripts/check-openai-runtime.spec.ts
```

For production, rotate any key that has been pasted into chat, committed, or otherwise exposed. Restrict the key to the required project and monitor usage limits with the configured provider.
