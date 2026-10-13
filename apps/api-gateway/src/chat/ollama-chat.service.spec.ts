import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OllamaChatService } from "./ollama-chat.service";

const schema = {
  type: "object",
  properties: { route: { type: "string", enum: ["static"] } },
  required: ["route"],
  additionalProperties: false,
};
const completed = (content = '{"route":"static"}', extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    done: true,
    done_reason: "stop",
    message: { content, thinking: "Private analysis is not JSON" },
    ...extra,
  }),
});
describe("OllamaChatService", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let service: OllamaChatService;
  let logger: {
    setServiceName: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://ollama:11434");
    vi.stubEnv("OLLAMA_CHAT_MODEL", "qwen3:1.7b-q4_K_M");
    vi.stubEnv("OLLAMA_REQUEST_TIMEOUT_MS", "60000");
    vi.stubEnv("OLLAMA_NUM_CTX", "32768");
    vi.stubEnv("GOOGLE_API_KEY", "");
    fetchMock = vi.fn().mockResolvedValue(completed());
    vi.stubGlobal("fetch", fetchMock);
    logger = { setServiceName: vi.fn(), info: vi.fn(), warn: vi.fn() };
    service = new OllamaChatService(logger as never);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  const call = (
    service: OllamaChatService,
    signal = new AbortController().signal,
  ) =>
    service.structured(
      "Phân loại",
      { question: "private question" },
      schema,
      signal,
    );
  it("uses exact Qwen model, native JSON schema and no Gemini credential; ignores thinking", async () => {
    expect(service.isConfigured()).toBe(true);
    expect(await call(service)).toEqual({ route: "static" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://ollama:11434/api/chat");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toMatchObject({
      model: "qwen3:1.7b-q4_K_M",
      stream: false,
      think: false,
      format: schema,
      options: { num_ctx: 32768, num_predict: 768, temperature: 0 },
    });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(
      "private question",
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(
      "Private analysis",
    );
  });
  it.each([
    "not JSON",
    '{"route":"unknown"}',
    '{"route":"static","injected":true}',
  ])("retries malformed/schema-invalid content once (%s)", async (content) => {
    fetchMock.mockResolvedValueOnce(completed(content));
    expect(await call(service)).toEqual({ route: "static" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(fetchMock.mock.calls[1][1].body).options.num_predict,
    ).toBe(1536);
  });
  it("fails explicitly after two invalid outputs", async () => {
    fetchMock.mockResolvedValue(completed('{"route":true}'));
    await expect(call(service)).rejects.toMatchObject({
      reason: "invalid_model_schema",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("rejects even valid JSON when the model reports truncation", async () => {
    fetchMock.mockResolvedValue(
      completed(undefined, { done_reason: "length" }),
    );
    await expect(call(service)).rejects.toMatchObject({
      reason: "model_output_truncated",
    });
  });
  it("rejects incomplete/empty output", async () => {
    fetchMock
      .mockResolvedValueOnce(completed("", { done: false }))
      .mockResolvedValueOnce(completed(""));
    await expect(call(service)).rejects.toMatchObject({
      reason: "empty_model_output",
    });
  });
  it("does not retry a missing model or expose provider bodies", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "private data" }),
    });
    await expect(call(service)).rejects.toMatchObject({
      status: 404,
      reason: "ollama_model_or_endpoint_not_found",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      "private data",
    );
  });
  it("retries a transient server failure once", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const result = call(service);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await result).toEqual({ route: "static" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("enforces timeout even when response body parsing hangs", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OLLAMA_REQUEST_TIMEOUT_MS", "1000");
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    });
    const rejection = expect(call(service)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
    expect(logger.warn).toHaveBeenCalledWith(
      "RAG model stage failed",
      expect.objectContaining({ reason: "ollama_timeout" }),
    );
  });
  it("respects caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(call(service, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("refuses oversized prompts before Ollama can truncate them", async () => {
    vi.stubEnv("OLLAMA_NUM_CTX", "4096");
    await expect(
      service.structured(
        "x",
        { question: "x".repeat(5000) },
        schema,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "ollama_context_budget_exceeded" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("validates action allowlist and refuses private fields", async () => {
    fetchMock.mockResolvedValue(
      completed('{"intent":"my_profile","arguments":{}}'),
    );
    expect(await service.understandAction("Hồ sơ của tôi", "citizen")).toEqual({
      intent: "my_profile",
      arguments: {},
    });
    fetchMock.mockResolvedValue(
      completed('{"intent":"my_profile","arguments":{"password":"private"}}'),
    );
    expect(
      await service.understandAction("Hồ sơ của tôi", "citizen"),
    ).toBeNull();
    fetchMock.mockResolvedValue(
      completed('{"intent":"execute_sql","arguments":{}}'),
    );
    expect(await service.understandAction("SQL", "citizen")).toBeNull();
  });
  it("logs startup model readiness or missing installation", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "qwen3:1.7b-q4_K_M" }] }),
    });
    await service.onModuleInit();
    expect(logger.info).toHaveBeenCalledWith(
      "Ollama startup ready",
      expect.objectContaining({ model: "qwen3:1.7b-q4_K_M" }),
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    });
    await service.onModuleInit();
    expect(logger.warn).toHaveBeenCalledWith(
      "Ollama startup unavailable",
      expect.objectContaining({ reason: "ollama_model_not_installed" }),
    );
  });
  it("rejects invalid configuration and reports safe connection codes", async () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://user:password@ollama:11434");
    expect(service.isConfigured()).toBe(false);
    vi.stubEnv("OLLAMA_BASE_URL", "http://ollama:11434");
    fetchMock.mockRejectedValue(
      new TypeError("secret endpoint", { cause: { code: "ECONNREFUSED" } }),
    );
    await expect(call(service)).rejects.toBeInstanceOf(TypeError);
    expect(logger.warn).toHaveBeenCalledWith(
      "RAG model stage failed",
      expect.objectContaining({ errorCode: "ECONNREFUSED" }),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      "secret endpoint",
    );
  });
});
