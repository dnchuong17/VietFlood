# VietFlood

## Chatbot API

The API gateway exposes authenticated `POST /chat`, `GET /chat/sessions`,
`GET /chat/sessions/:id/messages`, and `DELETE /chat/sessions/:id`.
See the [Chat API guide](docs/chat-api.md) for examples and pagination, and
the [Chat security and operations guide](docs/chat-security.md) for database,
encryption, deployment, and key rotation. Operators can use the
[chat backup and recovery runbook](docs/chat-backup-runbook.md) to verify backup
settings and recover persistent history.
See the [chatbot flow diagram](docs/chat-flow.md) for the request and answer paths.

Conversations belong to the verified JWT user and remain in Supabase
PostgreSQL until hard deletion. Message bodies are encrypted before storage.
`POST /chat` allows 20 requests per user per minute. Flood answers use local
hybrid Qdrant retrieval through the Python service and native Ollama
`qwen3:1.7b-q4_K_M` for source-grounded synthesis. Only the approved active
collection supplies evidence. See [Ollama deployment](docs/ollama-deployment.md).
The chatbot can perform authenticated report/profile actions with role checks
and confirmation. Current alerts and flood conditions are unsupported in the
static knowledge flow. Missing evidence or unavailable inference produces an
explicit notice rather than a canned knowledge answer.
