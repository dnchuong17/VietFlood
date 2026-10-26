# VietFlood

## Hướng dẫn sử dụng website

Xem [Sổ tay hướng dẫn sử dụng website VietFlood](docs/vietflood-user-guide.md)
để bắt đầu với vai trò người dân, đội cứu trợ hoặc quản trị viên. Tài liệu bằng
tiếng Việt gồm hướng dẫn từng bước, bảng quyền, sơ đồ luồng, bài thực hành và
cách xử lý sự cố thường gặp trên máy tính và trình duyệt điện thoại.

## Chatbot API

The API gateway exposes authenticated `POST /chat`, `GET /chat/sessions`,
`GET /chat/sessions/:id/messages`, and `DELETE /chat/sessions/:id`.
See the [Chat API guide](docs/chat-api.md) for examples and pagination, and
the [Chat security and operations guide](docs/chat-security.md) for database,
encryption, deployment, and key rotation. Operators can use the
[chat backup and recovery runbook](docs/chat-backup-runbook.md) to verify backup
settings and recover persistent history.
See the [OpenAI deployment guide](docs/openai-deployment.md) for provider setup
and the [chatbot flow diagram](docs/chat-flow.md) for the request and answer paths.

Conversations belong to the verified JWT user and remain in Supabase
PostgreSQL until hard deletion. Message bodies are encrypted before storage.
`POST /chat` allows 20 requests per user per minute. Flood answers use hybrid
Qdrant retrieval through the Python service and OpenAI for source-grounded
synthesis. Only the approved active collection supplies evidence.
The chatbot can perform authenticated report/profile actions with role checks
and confirmation. Current alerts and flood conditions are unsupported in the
static knowledge flow. Missing evidence or unavailable inference produces an
explicit notice rather than a canned knowledge answer.
