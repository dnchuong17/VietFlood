# Chat API for frontend developers

This guide covers sending messages and browsing persistent conversation history.

## Endpoint and authentication

Send a JSON `POST` request to `/chat` on the API gateway. Include the user's access token in the `Authorization` header:

```http
POST /chat
Authorization: Bearer <access-token>
Content-Type: application/json
```

The endpoint requires a valid, unexpired JWT. The gateway returns `401 Unauthorized` when the token is missing or invalid. The endpoint returns HTTP `200` for a successful reply.

## Request

```json
{
  "message": "Tôi cần chuẩn bị gì trước lũ?",
  "sessionId": "c8b9637e-6109-4c45-bd5f-02f38389a3ce"
}
```

| Field | Type | Required | Details |
| --- | --- | --- | --- |
| `message` | string | Yes | Message to send. It must contain 1–2000 characters. Leading and trailing whitespace is removed before processing; a whitespace-only message is rejected. |
| `sessionId` | UUID string | No | ID returned by an earlier successful response. Omit it to start a new conversation. |

Unknown fields are rejected. Send the returned session ID exactly as received; the API validates it as a UUID.

## Response

```json
{
  "answer": "Bạn nên theo dõi cảnh báo thời tiết...",
  "sessionId": "c8b9637e-6109-4c45-bd5f-02f38389a3ce"
}
```

| Field | Type | Details |
| --- | --- | --- |
| `answer` | string | Assistant's reply. |
| `sessionId` | UUID string | Conversation ID to include with the next message. |

Store the `sessionId` for the active conversation. Complete transcripts remain available until the user deletes them. The server uses at most the latest 10 eligible messages for follow-up context. Existing Redis-only conversations can be imported by reopening them while their 24-hour Redis key is still active. Older Redis content cannot be recovered.

## History endpoints

All routes require the same bearer JWT. History responses include `Cache-Control: private, no-store`.

| Method and path | Result |
| --- | --- |
| `GET /chat/sessions?limit=20&cursor=...` | `{ items: [{ sessionId, title, createdAt, updatedAt }], nextCursor }`, newest activity first. Titles are derived from the first message when read. |
| `GET /chat/sessions/:id/messages?limit=20&cursor=...` | `{ session, items: [{ id, role, kind, content, createdAt }], nextCursor }`. The first page contains the newest messages in display order. Use `nextCursor` to load older messages, then prepend them. |
| `DELETE /chat/sessions/:id` | `204 No Content`; immediately hard-deletes the session and its messages. |

The default page size is 20 and the maximum is 50. Send each cursor unchanged to the same endpoint. `createdAt` can be `null` for imported legacy content. List and message pages only include the signed-in user's data. Missing and other users' sessions both return `404` on history routes.

## Chat capabilities

- General flood safety questions are answered locally from Qdrant text passages. No staging passage is sent to Gemini. If no relevant information is found, the answer says so. First-aid guidance is returned locally.
- Questions about creating or submitting a report receive instructions to use the existing report form. Chat does not submit reports or upload evidence.
- Questions about the user's report status can return up to five recent reports, or a specific report when its number is included. The API only looks up reports belonging to the signed-in user.

The reply text is intended for display to the user. It can be in a language other than Vietnamese when the user asks for one.

## Errors

Errors use NestJS's standard JSON response, generally shaped like this:

```json
{
  "statusCode": 429,
  "message": "Chat request limit exceeded; try again in a minute",
  "error": "Too Many Requests"
}
```

| Status | Meaning | Frontend action |
| --- | --- | --- |
| `400` | Invalid body, unknown field, invalid UUID, or empty message after trimming. | Show a validation message and let the user edit the input. |
| `401` | Missing, invalid, or expired access token. | Use the app's existing sign-in or token-refresh flow. |
| `403` | The supplied session belongs to another user. | Do not retry that session; start a new one. |
| `404` | The session is missing, or is another user's session on a history route. | Refresh the conversation list. |
| `429` | The user exceeded 20 requests per minute. | Keep the draft and let the user retry after a short delay. |
| `503` | Chat is disabled for recovery, or a required database, Redis, report-status, or knowledge backend is unavailable. | Show a temporary-unavailable message and allow retry. |

The `message` field can be a string or an array for validation errors. Avoid depending on the optional `error` text for application logic; use `statusCode`.

## Frontend example

```ts
type ChatReply = {
  answer: string;
  sessionId: string;
};

async function sendChatMessage(
  message: string,
  accessToken: string,
  sessionId?: string,
): Promise<ChatReply> {
  const response = await fetch(`${API_BASE_URL}/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, ...(sessionId ? { sessionId } : {}) }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Object.assign(new Error(error.message ?? "Chat request failed"), {
      statusCode: response.status,
    });
  }

  return response.json() as Promise<ChatReply>;
}
```

Use the `sessionId` from each successful response for the next call:

```ts
const first = await sendChatMessage("Tôi cần chuẩn bị gì trước lũ?", token);
renderAssistantMessage(first.answer);

const next = await sendChatMessage("Còn nước uống thì sao?", token, first.sessionId);
renderAssistantMessage(next.answer);
```

`API_BASE_URL` should be the configured API gateway origin, including any deployment prefix if the environment uses one.
