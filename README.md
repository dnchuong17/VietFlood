# VietFlood

## Chatbot API

The API gateway exposes `POST /chat`. Send a bearer JWT and JSON such as
`{"message":"Tôi cần chuẩn bị gì trước lũ?"}`. The response is
`{"answer":"...","sessionId":"..."}`. Send the returned `sessionId` with
subsequent messages to continue the conversation. Sessions expire after 24
hours and belong to the signed-in user.
The endpoint allows 20 requests per user per minute; excess requests return 429.
It returns 400 for invalid input, 401 for missing or invalid JWTs, 403 for
another user's session, 404 for an expired session, and 503 when a required
backend is unavailable.

Configure the API gateway with `GOOGLE_API_KEY` (a Gemini API key),
`QDRANT_URL`, and `QDRANT_COLLECTION`. `GEMINI_CHAT_MODEL` defaults to
`gemini-3.7-flash`; `QDRANT_COLLECTION` defaults to
`flood_kb_staging_2026_01`. Set `QDRANT_API_KEY` if the Qdrant server requires
one. The gateway inspects a sample point for a text field and adds a Qdrant
text payload index if missing. Set `QDRANT_TEXT_FIELD` explicitly if the
content field is not one of `content`, `pageContent`, `page_content`, `text`,
`document`, `metadata.content`, or `metadata.text`. The current collection uses
`text`. New knowledge points must populate that same field. Qdrant access requires permission to read the
collection and create a payload index.

The chatbot searches Qdrant text payloads rather than its vectors. The existing
vectors use `intfloat/multilingual-e5-base`, for which this API has no query
embedding service. It can explain the report
form and show status for reports owned by the signed-in user. Report submission
and evidence uploads continue through the existing report endpoint.
The staging collection's review flags are not used to filter chat retrieval.
