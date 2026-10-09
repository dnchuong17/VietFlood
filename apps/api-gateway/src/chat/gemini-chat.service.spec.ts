import { afterEach, describe, expect, it, vi } from "vitest";

import { GeminiChatService } from "./gemini-chat.service";

describe("GeminiChatService", () => {
  const originalFetch = globalThis.fetch;
  const logger = { setServiceName: vi.fn(), warn: vi.fn() };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("sends only the current question, approved passages, and capped assistant context", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "private-api-key");
    vi.stubEnv("QDRANT_CHAT_COLLECTION", "curated-flood-kb");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "Câu trả lời." }] } }] }),
    });
    globalThis.fetch = fetchMock as never;
    const service = new GeminiChatService(logger as never);

    const answer = await service.answer(
      "Còn nước uống thì sao?",
      ["approved-1", "approved-2", "approved-3", "approved-4", "must-not-send-5"],
      [
        { role: "assistant", content: "must-not-send-oldest" },
        { role: "assistant", content: "approved-prior-1" },
        { role: "assistant", content: "approved-prior-2" },
      ],
    );

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request.body));
    const submittedText = JSON.stringify(body);
    expect(answer).toBe("Câu trả lời.");
    expect(url).toContain("models/gemini-3.8-flash:generateContent");
    expect(url).not.toContain("private-api-key");
    expect((request.headers as Record<string, string>)["x-goog-api-key"]).toBe("private-api-key");
    expect(submittedText).toContain("Còn nước uống thì sao?");
    expect(submittedText).toContain("approved-1");
    expect(submittedText).toContain("approved-4");
    expect(submittedText).toContain("approved-prior-1");
    expect(submittedText).toContain("approved-prior-2");
    expect(submittedText).not.toContain("private-api-key");
    expect(submittedText).not.toContain("must-not-send");
    expect(submittedText).not.toContain("role\":\"assistant\"");
  });

  it("does not call Google when either the API key or approved collection is missing", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "private-api-key");
    vi.stubEnv("QDRANT_CHAT_COLLECTION", "");
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const service = new GeminiChatService(logger as never);

    expect(service.isConfigured()).toBe(false);
    expect(await service.answer("question", ["passage"])).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps Gemini disabled if the approved collection is set to the staging collection", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "private-api-key");
    vi.stubEnv("QDRANT_COLLECTION", "flood_kb_staging_2026_01");
    vi.stubEnv("QDRANT_CHAT_COLLECTION", "flood_kb_staging_2026_01");
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const service = new GeminiChatService(logger as never);

    expect(service.isConfigured()).toBe(false);
    expect(await service.answer("question", ["staging passage"])).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null and logs no provider response when Google fails", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "private-api-key");
    vi.stubEnv("QDRANT_CHAT_COLLECTION", "curated-flood-kb");
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("private provider details")) as never;
    const service = new GeminiChatService(logger as never);

    expect(await service.answer("private question", ["private passage"])).toBeNull();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private question");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private provider details");
  });
});
