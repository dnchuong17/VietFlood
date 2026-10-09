# Chat API dành cho frontend

Tài liệu này hướng dẫn tích hợp gửi tin nhắn, tải lịch sử hội thoại, phân trang và xóa hội thoại VietFlood.

## Cấu hình chung

Các endpoint dưới đây chạy trên API gateway. Thay `API_BASE_URL` bằng origin của gateway trong môi trường hiện tại; thêm deployment prefix nếu có. Tất cả endpoint đều yêu cầu access token còn hiệu lực:

```http
Authorization: Bearer <access-token>
```

Các request có body dùng `Content-Type: application/json`. Lịch sử chat riêng tư và phản hồi chat có `Cache-Control: private, no-store`; không cache các response này ở CDN hoặc tầng chia sẻ.

## 1. Gửi tin nhắn

`POST /chat` trả lời bằng HTTP `200`.

```json
{
  "message": "Tôi cần chuẩn bị gì trước lũ?",
  "sessionId": "c8b9637e-6109-4c45-bd5f-02f38389a3ce"
}
```

| Trường | Kiểu | Bắt buộc | Quy tắc |
| --- | --- | --- | --- |
| `message` | string | Có | 1–2000 ký tự; khoảng trắng đầu/cuối được loại bỏ. Tin chỉ có khoảng trắng bị từ chối. |
| `sessionId` | UUID string | Không | ID từ response trước. Bỏ trường này để tạo hội thoại mới. API tạo session ID dạng UUID v4. |

Không gửi thêm field ngoài hai field trên. Response thành công:

```json
{
  "answer": "Theo kho kiến thức VietFlood: ...",
  "sessionId": "c8b9637e-6109-4c45-bd5f-02f38389a3ce"
}
```

Lưu `sessionId` để gửi tiếp tin nhắn và để tải/xóa hội thoại. Hội thoại gắn với tài khoản từ JWT. Mỗi lần gửi thành công, API lưu cả tin nhắn người dùng và câu trả lời. Tối đa 10 message gần nhất được dùng làm ngữ cảnh trả lời.

### Gửi tin nhắn bằng TypeScript

```ts
type ChatReply = { answer: string; sessionId: string };

async function sendMessage(
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
    throw Object.assign(new Error(messageFrom(error)), {
      statusCode: response.status,
    });
  }

  return response.json() as Promise<ChatReply>;
}

function messageFrom(error: { message?: string | string[] }): string {
  return Array.isArray(error.message)
    ? error.message.join(" ")
    : error.message ?? "Không gửi được tin nhắn.";
}
```

Dùng `sessionId` từ response mới nhất cho lần gửi tiếp theo:

```ts
const first = await sendMessage("Tôi cần chuẩn bị gì trước lũ?", token);
showAssistantMessage(first.answer);

const second = await sendMessage("Còn nước uống thì sao?", token, first.sessionId);
showAssistantMessage(second.answer);
```

## 2. Danh sách hội thoại

`GET /chat/sessions?limit=20&cursor=<cursor>` trả về hội thoại của tài khoản hiện tại, xếp theo hoạt động mới nhất trước.

| Query | Mặc định | Quy tắc |
| --- | --- | --- |
| `limit` | `20` | Số hội thoại mỗi trang, từ 1 đến 50. |
| `cursor` | Không có | Dùng nguyên `nextCursor` từ response trang trước. Tối đa 256 ký tự. |

Response:

```json
{
  "items": [
    {
      "sessionId": "c8b9637e-6109-4c45-bd5f-02f38389a3ce",
      "title": "Tôi cần chuẩn bị gì trước lũ?",
      "createdAt": "2026-10-09T04:00:00.000Z",
      "updatedAt": "2026-10-09T04:02:00.000Z"
    }
  ],
  "nextCursor": null
}
```

`title` được tạo từ message đầu tiên của người dùng. `createdAt` có thể là `null` với hội thoại cũ được chuyển từ bộ nhớ tạm. Khi `nextCursor` là `null`, không còn trang tiếp theo.

## 3. Tin nhắn trong một hội thoại

`GET /chat/sessions/:sessionId/messages?limit=20&cursor=<cursor>` trả về một trang tin nhắn theo thứ tự cũ đến mới. Trang đầu là các tin mới nhất. Các trường phân trang giống endpoint danh sách hội thoại.

```json
{
  "session": {
    "sessionId": "c8b9637e-6109-4c45-bd5f-02f38389a3ce",
    "title": "Tôi cần chuẩn bị gì trước lũ?",
    "createdAt": "2026-10-09T04:00:00.000Z",
    "updatedAt": "2026-10-09T04:02:00.000Z"
  },
  "items": [
    {
      "id": "7a85ce6f-1c38-4bc7-9f24-7e8c730cd744",
      "role": "user",
      "kind": "knowledge",
      "content": "Tôi cần chuẩn bị gì trước lũ?",
      "createdAt": "2026-10-09T04:00:00.000Z"
    },
    {
      "id": "02679158-a037-4240-998c-56ae916ea403",
      "role": "assistant",
      "kind": "knowledge",
      "content": "Theo kho kiến thức VietFlood: ...",
      "createdAt": "2026-10-09T04:00:01.000Z"
    }
  ],
  "nextCursor": "MQ"
}
```

`role` là `user` hoặc `assistant`. `kind` cho biết loại câu trả lời: `knowledge`, `first_aid`, `report_guide`, `report_status`, `fallback` hoặc `legacy`. Khi tải trang cũ hơn, gửi `nextCursor` vào đúng endpoint cùng `sessionId`, rồi **prepend** các `items` nhận được vào danh sách đang hiển thị. Dừng khi `nextCursor` là `null`.

Ví dụ:

```ts
const page = await fetch(
  `${API_BASE_URL}/chat/sessions/${sessionId}/messages?limit=20`,
  { headers: { Authorization: `Bearer ${token}` } },
).then((response) => response.json());

// Tải trang cũ hơn; giữ nguyên cursor từ response, không tự giải mã hoặc tạo cursor.
const olderPage = await fetch(
  `${API_BASE_URL}/chat/sessions/${sessionId}/messages?limit=20&cursor=${encodeURIComponent(page.nextCursor)}`,
  { headers: { Authorization: `Bearer ${token}` } },
).then((response) => response.json());
```

## 4. Xóa hội thoại

`DELETE /chat/sessions/:sessionId` xóa vĩnh viễn hội thoại và các tin nhắn của nó. Response thành công là `204 No Content` và không có JSON body. Sau khi thành công, bỏ hội thoại khỏi danh sách và đóng màn hình chat tương ứng ở client.

## 5. Hành vi của câu trả lời

- Câu hỏi về an toàn lũ dùng đoạn văn bản từ kho kiến thức VietFlood; khi không tìm thấy thông tin phù hợp, API trả lời rõ điều đó. Một số hướng dẫn sơ cứu đã rà soát được trả trực tiếp.
- Chat có thể hướng dẫn cách dùng biểu mẫu báo cáo hoặc đọc trạng thái báo cáo của chính người dùng. Việc gửi báo cáo và tải ảnh/video vẫn thực hiện qua API báo cáo hiện có.
- Nội dung `answer` là văn bản để hiển thị trong giao diện. Mặc định câu trả lời bằng tiếng Việt.

## 6. Lỗi và cách xử lý

NestJS trả lỗi dạng JSON, thường có `statusCode`, `message`, `error`. `message` có thể là chuỗi hoặc mảng. Dựa vào `statusCode` để xử lý; không dùng nội dung `error` làm điều kiện nghiệp vụ.

| HTTP | Ý nghĩa | FE nên làm gì |
| --- | --- | --- |
| `400` | Body, UUID, query hoặc cursor không hợp lệ. | Hiển thị lỗi nhập liệu; giữ nội dung người dùng đã soạn. |
| `401` | JWT thiếu, sai hoặc hết hạn. | Chạy luồng đăng nhập/làm mới token hiện có. |
| `403` | `POST /chat` dùng session thuộc tài khoản khác. | Không tiếp tục dùng session đó; tạo hội thoại mới. |
| `404` | Session không tồn tại, hết hạn trong Redis cũ, hoặc không thuộc tài khoản trên endpoint lịch sử. | Tải lại danh sách; nếu gửi chat tiếp thì bắt đầu session mới. Các endpoint lịch sử cố ý dùng `404` cả với session của tài khoản khác. |
| `429` | Vượt quá 20 request mỗi phút trên mỗi tài khoản. | Giữ draft và cho phép thử lại sau. |
| `503` | Lịch sử chat đang tắt hoặc một dịch vụ bắt buộc không khả dụng. | Hiển thị trạng thái tạm thời không khả dụng và cho phép thử lại. |

Các endpoint lịch sử dùng phân trang; hãy tránh gọi lặp liên tục khi cuộn. Việc xóa hội thoại là thao tác không thể khôi phục từ giao diện sau khi API trả thành công.
