import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyChatMigrations } from "./migrate-chat-history.js";
import { LoggerService } from "vietflood-common";

describe("Chat history deployment migrations", () => {
  it("upgrades and reruns with existing action and community report messages", async () => {
    // Model PostgreSQL validating existing rows when ADD CONSTRAINT runs.
    const existingKinds: string[] = [];
    let allowedKinds: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (!sql.includes("ADD CONSTRAINT messages_kind_check")) return;
        allowedKinds = [...sql.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
        if (existingKinds.some((kind) => !allowedKinds.includes(kind)))
          throw new Error("check constraint violated by existing row");
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };

    await applyChatMigrations(pool);
    for (const kind of ["small_talk", "community_reports", "action"]) {
      expect(allowedKinds).toContain(kind);
      existingKinds.push(kind);
    }
    await applyChatMigrations(pool);
    expect(client.release).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(2);
    expect(client.query.mock.calls[1][0]).toContain("pg_advisory_xact_lock");
  });

  it("rolls back and releases the connection when migration fails", async () => {
    const failure = new Error("permission denied");
    const client = {
      query: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    client.query.mockRejectedValueOnce(failure);
    await expect(applyChatMigrations({ connect: async () => client })).rejects.toBe(failure);
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each(["Dockerfile", "apps/api-gateway/Dockerfile"])("packages every migration used by the runner in %s", (file) => {
    const dockerfile = readFileSync(file, "utf8");
    expect(dockerfile).toContain("db/migrations/20261009_chat_history.sql");
    expect(dockerfile).toContain("db/migrations/20261009_chat_action_kind.sql");
  });
});

describe("Raw application log output", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits one JSON record with each metadata field and message exactly once", () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    const logger = new LoggerService();
    logger.setServiceName("OpenAIChatService");
    const fields = { requestId: "test-request", provider: "openai", model: "test-model",
      stage: "action", attempt: 1, elapsedMs: 4202, finishReason: "stop",
      responseChars: 59, outputTokens: 22, promptTokens: 413 };

    logger.info("RAG model response received", fields);

    expect(output).toHaveBeenCalledOnce();
    const line = output.mock.calls[0][0] as string;
    expect(JSON.parse(line)).toMatchObject({ ...fields, message: "RAG model response received", service: "OpenAIChatService" });
    expect(line.match(/RAG model response received/g)).toHaveLength(1);
    expect(line.length).toBeLessThan(1000);
  });
});
