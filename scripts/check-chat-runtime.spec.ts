import { afterEach, describe, expect, it, vi } from "vitest";
import { checkChatRuntime, validateRetrieval } from "./check-chat-runtime.js";

const health = {
  status: "ready", alias: "flood_kb_active",
  collection: "flood_kb_active_20261012170418_13a14650", pointCount: 212,
};
describe("Retrieval deployment readiness", () => {
  it("accepts the active alias even though it resolves to a versioned collection", () => {
    expect(validateRetrieval(health, "flood_kb_active")).toEqual({ alias: "flood_kb_active", pointCount: 212 });
  });
  it("identifies the physical collection configured instead of the alias", () => {
    expect(() => validateRetrieval(health, health.collection)).toThrow("retrieval_alias_mismatch");
    try { validateRetrieval(health, health.collection); }
    catch (error) {
      expect(error.details).toEqual({ expectedAlias: health.collection, reportedAlias: "flood_kb_active", reportedStatus: "ready", pointCount: 212 });
    }
  });
  it("fails when the retrieval service reports it is not ready", () => {
    expect(() => validateRetrieval({ ...health, status: "unavailable" }, health.alias)).toThrow("retrieval_not_ready");
  });
  it.each([0, -1, "212", 0.5, undefined])("rejects an empty or invalid point count: %s", (pointCount) => {
    expect(() => validateRetrieval({ ...health, pointCount }, health.alias)).toThrow("retrieval_empty_or_invalid_point_count");
  });
  it.each([null, undefined, [], "ready"])("rejects invalid health objects", (value) => {
    expect(() => validateRetrieval(value, health.alias)).toThrow("retrieval_invalid_health_response");
  });
  it("limits failure metadata to expected identifiers and counts", () => {
    try { validateRetrieval({ ...health, alias: "secret\nprovider text", token: "private-token" }, health.alias); }
    catch (error) {
      expect(error.details.reportedAlias).toBe("[invalid]");
      expect(JSON.stringify(error.details)).not.toMatch(/private-token|provider text/);
    }
  });
});

describe("Jenkins preflight failure output", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("prints the underlying TLS code instead of only TypeError and fails deployment", async () => {
    const Redis = require("ioredis");
    vi.spyOn(Redis.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(Redis.prototype, "ping").mockResolvedValue("PONG");
    vi.spyOn(Redis.prototype, "disconnect").mockImplementation(() => {});
    for (const [name, value] of Object.entries({
      RAG_SERVICE_URL: "http://retrieval.test", RAG_SERVICE_TOKEN: "private-rag-token",
      REDIS_HOST: "redis.test", REDIS_PORT: "6379", REDIS_DB: "0",
      OPENAI_API_KEY: "private-openai-key", OPENAI_BASE_URL: "https://provider.test/v1",
      OPENAI_CHAT_MODEL: "gpt-5-nano", OPENAI_REQUEST_TIMEOUT_MS: "120000",
      QDRANT_CHAT_COLLECTION: "flood_kb_active",
    })) vi.stubEnv(name, value);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => health })
      .mockRejectedValue(new TypeError("private driver details", { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }));
    vi.stubGlobal("fetch", fetchMock);
    const previousExitCode = process.exitCode;
    try {
      await checkChatRuntime();
      expect(process.exitCode).toBe(1);
      expect(output).toHaveBeenCalledOnce();
      expect(JSON.parse(output.mock.calls[0][0])).toEqual({ stage: "openai", status: "unavailable",
        reason: "openai_tls_error", errorType: "TypeError",
        errorCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", errorCodes: ["UNABLE_TO_VERIFY_LEAF_SIGNATURE"] });
      expect(JSON.stringify([...log.mock.calls, ...output.mock.calls])).not.toMatch(/private/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { process.exitCode = previousExitCode; }
  });
});
