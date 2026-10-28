import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIChatService } from "./openai-chat.service";

const schema = {
  type: "object", properties: { route: { type: "string", enum: ["static"] } },
  required: ["route"], additionalProperties: false,
};
const completed = (content = '{"route":"static"}', finishReason = "stop") => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content }, finish_reason: finishReason }] }),
});

describe("OpenAIChatService", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let service: OpenAIChatService;
  let logger: { setServiceName: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://cheapkeyai.shop/v1");
    vi.stubEnv("OPENAI_CHAT_MODEL", "gpt-5-nano");
    vi.stubEnv("OPENAI_REQUEST_TIMEOUT_MS", "120000");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    fetchMock = vi.fn().mockResolvedValue(completed());
    vi.stubGlobal("fetch", fetchMock);
    logger = { setServiceName: vi.fn(), info: vi.fn(), warn: vi.fn() };
    service = new OpenAIChatService(logger as never);
  });
  afterEach(() => {
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  });
  const call = (model: OpenAIChatService, signal = new AbortController().signal) =>
    model.structured("Classify the question", { question: "private question" }, schema, signal);

  it("uses OpenAI bearer authentication and JSON mode without Gemini credentials", async () => {
    expect(await call(service)).toEqual({ route: "static" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://cheapkeyai.shop/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer test-openai-key");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: "gpt-5-nano", response_format: { type: "json_object" }, reasoning_effort: "minimal", max_completion_tokens: 2048 });
    expect(body.messages[0]).toMatchObject({ role: "system" });
    expect(body.messages[0].content).toContain("JSON");
    expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/private question|test-openai-key/);
  });
  it.each([
    ["route", 2048], ["sufficient", 2048], ["claims", 8192], ["checks", 2048],
  ])("uses the nano request contract for %s", async (property, budget) => {
    const stageSchema = { type: "object", properties: { [property]: { type: "string" } }, required: [property] };
    fetchMock.mockResolvedValue(completed(JSON.stringify({ [property]: "test" })));
    await service.structured("Return JSON", {}, stageSchema, new AbortController().signal);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_completion_tokens).toBe(budget);
    expect(body.reasoning_effort).toBe("minimal");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("max_tokens");
  });
  it("uses configured defaults when provider and model overrides are absent", async () => {
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL;
    await call(service);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://cheapkeyai.shop/v1/chat/completions");
    expect(JSON.parse(init.body).model).toBe("gpt-5-nano");
  });
  it.each(["not JSON", '{"route":"unknown"}', '{"route":"static","injected":true}'])
  ("retries rejected output once and validates the replacement: %s", async (content) => {
    fetchMock.mockResolvedValueOnce(completed(content));
    expect(await call(service)).toEqual({ route: "static" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_completion_tokens).toBe(4096);
  });
  it("rejects truncated JSON even when it passes the local schema", async () => {
    fetchMock.mockResolvedValue(completed(undefined, "length"));
    await expect(call(service)).rejects.toMatchObject({ reason: "model_output_truncated" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([
    [401, "openai_authentication_failed"], [403, "openai_permission_denied"],
    [404, "openai_model_or_endpoint_not_found"], [429, "openai_rate_limit_or_quota_exceeded"],
  ])("reports HTTP %i safely without retrying", async (status, reason) => {
    const json = vi.fn().mockResolvedValue({ error: "private provider body" });
    fetchMock.mockResolvedValue({ ok: false, status, json });
    await expect(call(service)).rejects.toMatchObject({ status, reason });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (status !== 429) expect(json).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/private provider body|test-openai-key|private question/);
  });
  it.each(["insufficient_quota", "credit_balance_exhausted", "project_spend_limit_exceeded", "rate_limit_exceeded"])
  ("distinguishes known 429 codes without logging the error message: %s", async (code) => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: { code, message: "private provider details" } }) });
    await expect(call(service)).rejects.toMatchObject({ reason: `openai_${code}`, status: 429 });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private provider details");
  });
  it("enforces the deadline while response body parsing is stalled", async () => {
    vi.useFakeTimers(); vi.stubEnv("OPENAI_REQUEST_TIMEOUT_MS", "1000");
    fetchMock.mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
    const rejection = expect(call(service)).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
    expect(logger.warn).toHaveBeenCalledWith("RAG model stage failed", expect.objectContaining({ reason: "openai_timeout" }));
  });
  it("honors caller cancellation before making a request", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(call(service, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("preserves optional action fields and rejects private fields or unknown intents", async () => {
    fetchMock.mockResolvedValue(completed('{"intent":"create_report","arguments":{"description":"ngập"}}'));
    expect(await service.understandAction("Đường ngập", "citizen")).toEqual({ intent: "create_report", arguments: { description: "ngập" } });
    fetchMock.mockResolvedValue(completed('{"intent":"my_profile","arguments":{"password":"private"}}'));
    expect(await service.understandAction("Hồ sơ", "citizen")).toBeNull();
    fetchMock.mockResolvedValue(completed('{"intent":"execute_sql","arguments":{}}'));
    expect(await service.understandAction("SQL", "citizen")).toBeNull();
  });
  it("supplies bounded allowlisted draft fields and missing fields for terse followups", async () => {
    fetchMock.mockResolvedValue(completed('{"intent":"create_report","arguments":{"ward":"Phường Bùi Đình Túy"}}'));
    await service.understandAction("Phường Bùi Đình Túy", "citizen", {
      intent: "create_report",
      arguments: { category: ["flood"], description: "Ngập đường", province: "TP.HCM", ward: " ", addressLine: "12 Đường A", userId: 999, reportId: 123, role: "admin", password: "private", token: "secret", extra: "untrusted" },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const data = JSON.parse(body.messages[1].content);
    expect(data).toEqual({ role: "citizen", message: "Phường Bùi Đình Túy", pendingIntent: "create_report", pendingArguments: { category: ["flood"], description: "Ngập đường", province: "TP.HCM", addressLine: "12 Đường A" }, missingFields: ["ward"] });
    expect(body.messages[0].content).toContain("Không tự suy ra");
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("recovers action parsing after a transient connection timeout without changing the prompt", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError("private provider connection"), { cause: { code: "ETIMEDOUT" } }));
    fetchMock.mockResolvedValue(completed('{"intent":"create_report","arguments":{"description":"ngập"}}'));
    const result = service.understandAction("private question", "citizen");
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toEqual({ intent: "create_report", arguments: { description: "ngập" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
    expect(logger.warn).toHaveBeenCalledWith("RAG model transport retry", expect.objectContaining({ stage: "action", errorCode: "ETIMEDOUT", reason: "connection_timeout", nextAttempt: 2 }));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/private provider connection|private question|test-openai-key/);
  });

  it("stops persistent connection failures after three transport attempts", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError("private upstream", { cause: new AggregateError([Object.assign(new Error(), { code: "ETIMEDOUT" })]) }));
    const assertion = expect(call(service)).rejects.toBeInstanceOf(TypeError);
    await vi.advanceTimersByTimeAsync(750);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith("RAG model stage failed", expect.objectContaining({ reason: "connection_timeout", errorCode: "ETIMEDOUT" }));
  });

  it("does not retry a TLS verification failure", async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError("private TLS details"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }));
    await expect(call(service)).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("RAG model stage failed", expect.objectContaining({ reason: "tls_failure" }));
  });

  it("reports startup configuration safely and rejects a missing key", () => {
    service.onModuleInit();
    expect(logger.info).toHaveBeenCalledWith("OpenAI chatbot configuration ready", expect.objectContaining({ provider: "openai", model: "gpt-5-nano" }));
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(service.isConfigured()).toBe(false);
    service.onModuleInit();
    expect(logger.warn).toHaveBeenCalledWith("OpenAI chatbot configuration unavailable", expect.objectContaining({ reason: "missing_openai_api_key" }));
  });
});
