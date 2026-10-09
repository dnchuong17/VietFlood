# VietFlood

## Chatbot API

The API gateway exposes authenticated `POST /chat`, `GET /chat/sessions`,
`GET /chat/sessions/:id/messages`, and `DELETE /chat/sessions/:id`.
See the [Chat API guide](docs/chat-api.md) for examples and pagination, and
the [Chat security and operations guide](docs/chat-security.md) for database,
encryption, deployment, and key rotation. Operators can use the
[chat backup and recovery runbook](docs/chat-backup-runbook.md) to verify backup
settings and recover persistent history.

Conversations belong to the verified JWT user and remain in Supabase
PostgreSQL until hard deletion. Message bodies are encrypted before storage.
`POST /chat` allows 20 requests per user per minute. Flood answers use local
Qdrant retrieval; when a separate curated collection and Gemini API key are
configured, approved passages can be sent to Gemini for grounded synthesis.
Staging passages are never sent to Gemini. The chatbot
can also explain the existing report form and read only the signed-in user's
report status. For recent flood-location questions, it shows area-level
summaries of verified VietFlood flood reports from the last 24 hours without
exposing report descriptions, exact addresses, coordinates, or reporter data.
