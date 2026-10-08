# VietFlood

## Chatbot API

The API gateway exposes authenticated `POST /chat`, `GET /chat/sessions`,
`GET /chat/sessions/:id/messages`, and `DELETE /chat/sessions/:id`.
See the [Chat API guide](docs/chat-api.md) for examples and pagination, and
the [Chat security and operations guide](docs/chat-security.md) for database,
encryption, deployment, and recovery instructions.

Conversations belong to the verified JWT user and remain in Supabase
PostgreSQL until hard deletion. Message bodies are encrypted before storage.
`POST /chat` allows 20 requests per user per minute. Flood answers use local
Qdrant text retrieval; staging passages are not sent to Gemini. The chatbot
can also explain the existing report form and read only the signed-in user's
report status.
