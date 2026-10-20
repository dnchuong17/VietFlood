import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ChatHistoryRepository } from "./chat-history.repository";

// The repository loads pg with require, so replace that same CommonJS export.
const pg = require("pg");

describe("Chat history database failures", () => {
  const logger = { setServiceName: vi.fn(), warn: vi.fn() };
  let pool: EventEmitter & { query: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  let repository: ChatHistoryRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DATABASE_URL", "postgres://test:test@localhost/test");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CHAT_DB_CA_BASE64", "");
    pool = Object.assign(new EventEmitter(), {
      query: vi.fn(), connect: vi.fn(), end: vi.fn(),
    });
    vi.spyOn(pg, "Pool").mockImplementation(function () { return pool; });
    repository = new ChatHistoryRepository({} as never, logger as never);
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("handles idle connection errors and allows a subsequent read", async () => {
    expect(() => pool.emit("error", Object.assign(new Error("private driver text"), { code: "ECONNRESET" })))
      .not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith("Chat history idle connection failed", { code: "ECONNRESET" });
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(repository.access(7, "session")).resolves.toBe("missing");
  });

  it("reports an action schema failure without exposing query parameters or driver text", async () => {
    pool.connect.mockResolvedValue({
      query: vi.fn().mockRejectedValue(Object.assign(new Error("private content and database URL"), {
        code: "23514", constraint: "messages_kind_check", detail: "private message",
      })), release: vi.fn(),
    });
    await expect(repository.create(7, "session", "private question", "private answer", "action"))
      .rejects.toMatchObject({ status: 503 });
    expect(logger.warn).toHaveBeenCalledWith("Chat history database operation failed", {
      code: "23514", constraint: "messages_kind_check",
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/private content|private message|private question/);
  });

  it("discards a client when rollback fails and never retries a write", async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error("connection lost")), release: vi.fn() };
    pool.connect.mockResolvedValue(client);
    await expect(repository.create(7, "session", "question", "answer", "action"))
      .rejects.toMatchObject({ status: 503 });
    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.connect).toHaveBeenCalledOnce();
  });

  it("keeps arbitrary error strings out of diagnostic metadata", async () => {
    pool.query.mockRejectedValue({ code: "private data", constraint: "private data" });
    await expect(repository.access(7, "session")).rejects.toMatchObject({ status: 503 });
    expect(logger.warn).toHaveBeenCalledWith("Chat history database operation failed", { code: "unknown" });
  });

  it("ends its pool on shutdown", async () => {
    await repository.onModuleDestroy();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
