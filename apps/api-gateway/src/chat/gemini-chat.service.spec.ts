import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const langchain = vi.hoisted(() => ({
  calls: [] as Array<{ prompts: unknown[]; input: unknown; options: Record<string, unknown> }>,
  output: "Câu trả lời." as unknown,
  failure: false,
  modelOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock("@langchain/core/prompts", () => ({
  ChatPromptTemplate: {
    fromMessages: (prompts: unknown[]) => ({
      pipe: (model: { invoke: (input: unknown) => Promise<unknown> }) => ({
        invoke: async (input: unknown) => {
          if (langchain.failure) throw new Error("private provider details");
          return model.invoke({ prompts, input });
        },
      }),
    }),
  },
}));

vi.mock("@langchain/google", () => ({
  ChatGoogle: class {
    constructor(options: Record<string, unknown>) {
      langchain.modelOptions.push(options);
    }
    async invoke(input: unknown) {
      langchain.calls.push({ prompts: (input as { prompts: unknown[] }).prompts, input, options: {} });
      return { content: langchain.output };
    }
    withStructuredOutput() {
      return {
        invoke: async (input: unknown) => {
          langchain.calls.push({ prompts: (input as { prompts: unknown[] }).prompts, input, options: { structured: true } });
          return langchain.output;
        },
      };
    }
  },
}));

import { GeminiChatService } from "./gemini-chat.service";

describe("GeminiChatService", () => {
  const logger = { setServiceName: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    langchain.calls = [];
    langchain.output = "Câu trả lời.";
    langchain.failure = false;
    langchain.modelOptions = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("sends only the current question, approved passages, and capped assistant context through LangChain", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "private-api-key");
    vi.stubEnv("QDRANT_CHAT_COLLECTION", "curated-flood-kb");
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

    expect(answer).toBe("Câu trả lời.");
    const promptText = JSON.stringify(langchain.calls[0]?.prompts);
    const inputText = JSON.stringify(langchain.calls[0]?.input);
    expect(promptText).toContain("Bạn là trợ lý VietFlood");
    expect(promptText).toContain("giọng bình tĩnh, chuyên nghiệp, tự nhiên");
    expect(promptText).toContain("không mở đầu bằng lời giới thiệu về bản thân");
    expect(inputText).toContain("Còn nước uống thì sao?");
    expect(inputText).toContain("approved-1");
    expect(inputText).toContain("approved-4");
    expect(inputText).toContain("approved-prior-1");
    expect(inputText).toContain("approved-prior-2");
    expect(inputText).not.toContain("private-api-key");
    expect(inputText).not.toContain("must-not-send");
    expect(langchain.modelOptions[0]).toMatchObject({ model: "gemini-3.8-flash", temperature: 0.2, maxOutputTokens: 512 });
  });

  it("does not call LangChain when either the API key or approved collection is missing", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "private-api-key");
    vi.stubEnv("QDRANT_CHAT_COLLECTION", "");
    const service = new GeminiChatService(logger as never);

    expect(service.isConfigured()).toBe(false);
    expect(await service.answer("question", ["passage"])).toBeNull();
    expect(langchain.calls).toHaveLength(0);
  });

  it("keeps generated answers disabled when the approved collection is the staging collection", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "private-api-key");
    vi.stubEnv("QDRANT_COLLECTION", "flood_kb_staging_2026_01");
    vi.stubEnv("QDRANT_CHAT_COLLECTION", "flood_kb_staging_2026_01");
    const service = new GeminiChatService(logger as never);

    expect(service.isConfigured()).toBe(false);
    expect(await service.answer("question", ["staging passage"])).toBeNull();
    expect(langchain.calls).toHaveLength(0);
  });

  it("uses structured LangChain output for allowlisted action intent extraction", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "private-api-key");
    vi.stubEnv("QDRANT_CHAT_COLLECTION", "");
    langchain.output = {
      intent: "create_report",
      arguments: { category: "flood", description: "Ngập đường" },
    };
    const service = new GeminiChatService(logger as never);

    await expect(service.understandAction("Tạo báo cáo ngập đường", "citizen"))
      .resolves.toEqual({ intent: "create_report", arguments: { category: "flood", description: "Ngập đường" } });
    expect(langchain.calls[0]?.options.structured).toBe(true);
    expect(JSON.stringify(langchain.calls[0]?.input)).toContain("Tạo báo cáo ngập đường");
  });

  it("rejects malformed or disallowed structured action output", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "private-api-key");
    const service = new GeminiChatService(logger as never);

    langchain.output = { intent: "execute_arbitrary_code", arguments: {} };
    await expect(service.understandAction("do something", "admin")).resolves.toBeNull();
    langchain.output = { intent: "delete_report", arguments: [] };
    await expect(service.understandAction("delete", "admin")).resolves.toBeNull();
  });

  it("returns null and logs no provider response when LangChain fails", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "private-api-key");
    vi.stubEnv("QDRANT_CHAT_COLLECTION", "curated-flood-kb");
    langchain.failure = true;
    const service = new GeminiChatService(logger as never);

    expect(await service.answer("private question", ["private passage"])).toBeNull();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private question");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private provider details");
  });
});
