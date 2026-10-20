import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkOpenAI, openaiConfiguration, openaiFailureDetails } from "./check-openai-runtime.js";

const env = {
  OPENAI_API_KEY: "probe-test-key", OPENAI_BASE_URL: "https://cheapkeyai.shop/v1/",
  OPENAI_CHAT_MODEL: "gpt-5-nano", OPENAI_REQUEST_TIMEOUT_MS: "120000",
};
const completed = (content = '{"ready":true}', finish_reason = "stop") => ({
  ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason }] }),
});
describe("OpenAI deployment probe", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(completed());
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("verifies a real completion contract and returns only safe metadata", async () => {
    const result = await checkOpenAI(env);
    expect(result).toMatchObject({ provider: "openai", model: "gpt-5-nano", serviceOrigin: "https://cheapkeyai.shop" });
    expect(JSON.stringify(result)).not.toContain("probe-test-key");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://cheapkeyai.shop/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer probe-test-key");
    expect(JSON.parse(init.body)).toMatchObject({ model: "gpt-5-nano", max_completion_tokens: 1024, reasoning_effort: "minimal", response_format: { type: "json_object" } });
  });
  it.each([401, 403, 404, 429, 503])("fails deployment on HTTP %i without exposing API bodies", async (status) => {
    const json = vi.fn().mockResolvedValue({ error: "private response" });
    fetchMock.mockResolvedValue({ ok: false, status, json });
    await expect(checkOpenAI(env)).rejects.toThrow(new RegExp(`openai_.*_${status}`));
    expect(fetchMock).toHaveBeenCalledOnce();
    if (status !== 429) expect(json).not.toHaveBeenCalled();
  });
  it.each(["insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded", "rate_limit_exceeded"])
  ("reports only allowlisted 429 codes: %s", async (code) => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: { code, message: "secret provider body" } }) });
    await expect(checkOpenAI(env)).rejects.toThrow(`openai_${code}_429`);
  });
  it("does not include arbitrary provider error codes in the result", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: { code: "private data" } }) });
    await expect(checkOpenAI(env)).rejects.toThrow("openai_rate_limit_or_quota_exceeded_429");
  });
  it.each([["not JSON", "stop"], ['{"ready":false}', "stop"], ['{"ready":true}', "length"]])
  ("rejects invalid or truncated probe output", async (content, finishReason) => {
    fetchMock.mockResolvedValue(completed(content, finishReason));
    await expect(checkOpenAI(env)).rejects.toThrow("openai_invalid_probe_response");
  });
  it("bounds the deadline even if response parsing hangs", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    fetchMock.mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
    const rejection = expect(checkOpenAI(env)).rejects.toMatchObject({ name: "TimeoutError" });
    controller.abort(new DOMException("deadline", "TimeoutError"));
    await rejection;
  });
  it.each([
    { OPENAI_API_KEY: " " }, { OPENAI_CHAT_MODEL: " " }, { OPENAI_REQUEST_TIMEOUT_MS: "NaN" },
    { OPENAI_BASE_URL: "http://remote.example/v1" }, { OPENAI_BASE_URL: "https://user:secret@example.com/v1" },
  ])("rejects invalid configuration before contacting a provider", async (override) => {
    await expect(checkOpenAI({ ...env, ...override })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("allows an explicit localhost endpoint for isolated integration checks", () => {
    expect(openaiConfiguration({ ...env, OPENAI_BASE_URL: "http://127.0.0.1:5000/v1" }).baseUrl).toBe("http://127.0.0.1:5000/v1");
  });

  it("recovers from a temporary connection reset within the same deadline", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
    expect(await checkOpenAI(env)).toMatchObject({ attempts: 2, model: "gpt-5-nano" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].signal).toBe(fetchMock.mock.calls[1][1].signal);
  });

  it("bounds retries when the resolver stays temporarily unavailable", async () => {
    const error = new TypeError("fetch failed", { cause: { code: "EAI_AGAIN" } });
    fetchMock.mockRejectedValue(error);
    await expect(checkOpenAI(env)).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(openaiFailureDetails(error)).toMatchObject({ reason: "openai_dns_error", errorCode: "EAI_AGAIN" });
  });

  it.each(["ENOTFOUND", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"])
  ("does not retry permanent DNS or certificate errors: %s", async (code) => {
    const error = new TypeError("fetch failed", { cause: { code } });
    fetchMock.mockRejectedValue(error);
    await expect(checkOpenAI(env)).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("honors the shared deadline while waiting to retry", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    fetchMock.mockRejectedValue(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
    const rejection = expect(checkOpenAI(env)).rejects.toMatchObject({ name: "TimeoutError" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new DOMException("deadline", "TimeoutError"));
    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("Safe OpenAI preflight diagnostics", () => {
  it("extracts nested socket codes without leaking hostnames, credentials, or messages", () => {
    const error = new TypeError("secret https://user:password@private-host", {
      cause: Object.assign(new AggregateError([
        Object.assign(new Error("private IP"), { code: "ENETUNREACH" }),
        { code: "ETIMEDOUT", hostname: "private-host" },
      ]), { code: "ETIMEDOUT" }),
    });
    expect(openaiFailureDetails(error)).toEqual({ reason: "openai_connection_timeout", errorType: "TypeError",
      errorCode: "ETIMEDOUT", errorCodes: ["ETIMEDOUT", "ENETUNREACH"] });
    expect(JSON.stringify(openaiFailureDetails(error))).not.toMatch(/secret|password|private/);
  });

  it("handles cyclic causes and ignores unknown diagnostic values", () => {
    const error = { name: "secret", message: "private error", code: "private-code", cause: null as unknown };
    error.cause = error;
    expect(openaiFailureDetails(error)).toEqual({ reason: "openai_probe_failed", errorType: "Error" });
    expect(openaiFailureDetails(null)).toEqual({ reason: "openai_probe_failed", errorType: "Error" });
  });

  it.each([
    [new DOMException("private message", "TimeoutError"), "openai_timeout"],
    [new SyntaxError("private response body"), "openai_invalid_response_json"],
    [new TypeError("fetch failed"), "openai_connection_failed"],
    [new TypeError("private programming error"), "openai_probe_failed"],
    [new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } }), "openai_tls_error"],
  ])("reports a safe reason for %s", (error, reason) => {
    expect(openaiFailureDetails(error).reason).toBe(reason);
    expect(JSON.stringify(openaiFailureDetails(error))).not.toContain("private");
  });
});
