import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const langchain = vi.hoisted(() => ({
  calls: [] as Array<{ prompts: unknown[]; input: unknown; options: Record<string, unknown> }>,
  output: "Câu trả lời." as unknown,
  failure: false,
  rawText: undefined as string | undefined,
  finishReason: "STOP",
  hang: false,
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
    withConfig() {
      return {
        invoke: async (input: unknown) => {
          langchain.calls.push({ prompts: (input as { prompts: unknown[] }).prompts, input, options: { structured: true } });
          if (langchain.hang) return new Promise(() => {});
          return { content: langchain.rawText ?? JSON.stringify(langchain.output), additional_kwargs: { finishReason: langchain.finishReason }, usage_metadata: { output_tokens: 100 } };
        },
      };
    }
  },
}));

import { GeminiChatService } from "./gemini-chat.service";

describe("GeminiChatService", () => {
  const logger = { setServiceName: vi.fn(), info: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    langchain.calls = [];
    langchain.output = "Câu trả lời.";
    langchain.failure = false;
    langchain.rawText = undefined;
    langchain.finishReason = "STOP";
    langchain.hang = false;
    langchain.modelOptions = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("passes structured RAG data without exposing the API key", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "private-api-key");
    langchain.output = { route: "static", queries: ["lũ"], dynamicParts: [] };
    const service = new GeminiChatService(logger as never);
    expect(await service.structured("Route only", { question: "Cần chuẩn bị gì?" }, { type: "object" }, AbortSignal.timeout(1000))).toEqual(langchain.output);
    expect(JSON.stringify(langchain.calls[0])).not.toContain("private-api-key");
    expect(langchain.calls[0].options.structured).toBe(true);
  });

  it("rejects missing Gemini configuration", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "");
    const service = new GeminiChatService(logger as never);
    await expect(service.structured("route", {}, {}, AbortSignal.timeout(1000))).rejects.toThrow("missing_api_key");
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

    await expect(service.structured("route", { question: "private question", evidence: "private passage" }, {}, AbortSignal.timeout(1000))).rejects.toThrow();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private question");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private provider details");
  });
  it("rejects truncated output instead of parsing an incomplete object", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "private-api-key");
    langchain.finishReason = "MAX_TOKENS";
    langchain.rawText = '{"claims":[';
    await expect(new GeminiChatService(logger as never).structured("generate", {}, {}, AbortSignal.timeout(1000))).rejects.toThrow("model_output_truncated");
    expect(langchain.calls).toHaveLength(2);
    expect(langchain.modelOptions.map(o => o.maxOutputTokens)).toEqual([4096, 8192]);
  });

  it("rejects invalid JSON and logs a reason without the response text", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "private-api-key");
    langchain.rawText = 'private malformed response';
    await expect(new GeminiChatService(logger as never).structured("route", {}, {}, AbortSignal.timeout(1000))).rejects.toThrow("invalid_model_json");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private malformed response");
    expect(langchain.modelOptions[0]).toMatchObject({ maxRetries: 0 });
  });

  it("enforces the stage timeout even if the SDK ignores the abort signal", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GOOGLE_API_KEY", "private-api-key");
    langchain.hang = true;
    const result = new GeminiChatService(logger as never).structured("route", {}, {}, new AbortController().signal);
    const assertion = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(25000);
    await assertion;
    expect(langchain.calls).toHaveLength(1);
  });

  it("honors an already aborted parent deadline without sending a request", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "private-api-key");
    const controller = new AbortController(); controller.abort();
    await expect(new GeminiChatService(logger as never).structured("route", {}, {}, controller.signal)).rejects.toThrow();
    expect(langchain.calls).toHaveLength(0);
  });

});
