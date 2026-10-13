# Ollama cho VietFlood

Chatbot dùng `qwen3:1.7b-q4_K_M` qua API Ollama. Không cần Google API key. Kho vector E5/BM25 và dịch vụ Python RAG giữ nguyên.

## Local

```sh
ollama serve
# Chạy trong terminal thứ hai:
ollama pull qwen3:1.7b-q4_K_M
# Tùy chọn để chat trực tiếp (không đi qua RAG):
ollama run qwen3:1.7b-q4_K_M
```

Backend `.env`:

```dotenv
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_CHAT_MODEL=qwen3:1.7b-q4_K_M
OLLAMA_REQUEST_TIMEOUT_MS=120000
OLLAMA_NUM_CTX=16384
RAG_REQUEST_TIMEOUT_MS=300000
RAG_RETRIEVAL_TIMEOUT_MS=90000
# Giữ RAG_SERVICE_URL và RAG_SERVICE_TOKEN đang hoạt động.
```

## Server qua Jenkins và Portainer

Đặt trong `/opt/env/vietflood.env` trên Jenkins agent:

```dotenv
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_CHAT_MODEL=qwen3:1.7b-q4_K_M
OLLAMA_REQUEST_TIMEOUT_MS=120000
OLLAMA_NUM_CTX=16384
RAG_REQUEST_TIMEOUT_MS=300000
RAG_RETRIEVAL_TIMEOUT_MS=90000
RAG_SERVICE_URL=https://vietflood-rag.ndtd.indevs.in
# Giữ RAG_SERVICE_TOKEN hiện có, không gửi key/token vào chat.
```

Xóa cấu hình provider Google cũ. `.env` local không cập nhật file server này.
Sau khi code được push và Jenkins build, pipeline sẽ:

1. Tạo/chạy `vietflood-ollama` trên `jenkins_default`, alias `ollama`, không mở cổng ra Internet.
2. Lưu model ở volume `vietflood_ollama_models`, pull đúng tag trước khi thay backend.
3. Kiểm tra RAG `/health/ready`, đúng alias và số điểm lớn hơn 0; kiểm tra model đã cài rồi tải model vào bộ nhớ. Lỗi bước này dừng deploy và giữ backend cũ.
4. Chạy backend với các biến Ollama. Startup ghi `Ollama startup ready`; log mỗi stage có provider/model/timing/reason.

Trong Portainer có thể xem Logs của `vietflood-ollama`. Mở Console container Ollama và chạy `ollama list` để xem model đã tải. Console backend chạy:

```sh
printenv OLLAMA_BASE_URL OLLAMA_CHAT_MODEL
node /app/scripts/check-chat-runtime.js
```

Không sửa container thủ công để cấu hình lâu dài: Jenkins tạo lại backend và lấy biến từ file server. Nếu có endpoint Ollama riêng, đặt `OLLAMA_BASE_URL` về endpoint đó; Jenkins kiểm tra endpoint và model nhưng không tạo/pull container thay bạn.

## Chạy bằng Compose

Hai file Compose có service `ollama`, `ollama-init` và volume `ollama_models`. Gateway chờ `ollama-init` pull model thành công. `OLLAMA_DOCKER_BASE_URL` mặc định `http://ollama:11434`; không dùng localhost bên trong container để gọi container khác. `RAG_DOCKER_SERVICE_URL` mặc định gọi `rag-retrieval`; đặt thành endpoint hiện có nếu dùng RAG đã triển khai riêng. Image gateway phải được build từ code mới; compose prod không tự build image remote.

```sh
docker compose up -d --build
# Hoặc dùng các image đã publish:
docker compose -f docker-compose.prod.yml up -d
```

Câu chỉ hỏi số liệu/cảnh báo hiện tại có thêm chặn theo phạm vi trước model, tránh model nhỏ phân loại nhầm và dùng tài liệu tĩnh làm tình hình hiện tại. Câu hỏi kiến thức và nhiều ý vẫn đi qua planner.

Model chạy CPU khi không cấu hình GPU. Model nhỏ không bảo đảm chất lượng bằng model lớn; độ trễ phụ thuộc CPU/RAM và kích thước evidence. Gateway giữ kiểm tra JSON, căn cứ nguồn, quote nguyên văn và timeout. Nếu model không vượt qua kiểm tra, bot trả thông báo thiếu kiến thức/lỗi thay vì tự tạo lời khuyên. Bộ đánh giá production cần chạy lại trên server sau deploy.

## Kết quả kiểm tra local (2026-10-13)

- 73 unit/security tests qua; 14 ca opt-in mặc định không chạy.
- Build API gateway và kiểm tra cấu hình hai Compose file thành công. Các shell stage Jenkins qua kiểm tra cú pháp; chưa chạy Jenkins trên server.
- Model thật đã tải đúng tag; preflight xác nhận alias `flood_kb_active` có 212 điểm và tải model vào bộ nhớ.
- Câu chuẩn bị trước lũ đi qua HTTP/JWT, retrieval public, Ollama, kiểm chứng nguồn và endpoint snapshot; lần chạy cuối khoảng 102 giây (lần trước 121 giây). Không coi đây là độ trễ server Ollama hay bằng chứng toàn bộ bộ câu hỏi vàng đạt.
- Phép thử câu cần dữ liệu hiện tại qua chặn phạm vi. Các lần thử trước khi chỉnh timeout/phân loại đã thất bại; bộ đánh giá đầy đủ cần chạy lại trên server sau deploy.
