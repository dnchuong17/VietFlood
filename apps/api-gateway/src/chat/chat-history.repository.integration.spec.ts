import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";

import { ChatCryptoService } from "./chat-crypto.service";
import { ChatHistoryRepository } from "./chat-history.repository";

const testUrl = process.env.CHAT_TEST_DATABASE_URL;
const isolated = process.env.CHAT_TEST_DATABASE_ISOLATED === "YES";

describe.skipIf(!testUrl || !isolated)("ChatHistoryRepository isolated PostgreSQL integration", () => {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: testUrl, max: 1 });
  const logger = { setServiceName: vi.fn(), warn: vi.fn() };
  let repository: ChatHistoryRepository;
  const owner = 900001;
  const stranger = 900002;

  beforeAll(async () => {
    // This suite may only run against a disposable database named by both opt-in variables.
    await pool.query("CREATE TABLE IF NOT EXISTS public.users (id integer PRIMARY KEY)");
    const migration = readFileSync(resolve("db/migrations/20261009_chat_history.sql"), "utf8");
    await pool.query(migration);
    const smallTalkMigration = readFileSync(resolve("db/migrations/20261009_chat_small_talk_kind.sql"), "utf8");
    await pool.query(smallTalkMigration);
    const communityReportsMigration = readFileSync(resolve("db/migrations/20261009_chat_community_reports_kind.sql"), "utf8");
    await pool.query(communityReportsMigration);
    const actionMigration = readFileSync(resolve("db/migrations/20261009_chat_action_kind.sql"), "utf8");
    await pool.query(actionMigration);
    await pool.query("INSERT INTO public.users (id) VALUES ($1), ($2) ON CONFLICT DO NOTHING", [owner, stranger]);
    vi.stubEnv("DATABASE_URL", testUrl);
    vi.stubEnv("CHAT_KEY_CURRENT", "V1");
    vi.stubEnv("CHAT_KEYRING_B64", Buffer.from(JSON.stringify({ V1: Buffer.alloc(32, 7).toString("base64") })).toString("base64"));
    repository = new ChatHistoryRepository(new ChatCryptoService(), logger as never);
  });

  afterAll(async () => {
    if (repository) await repository.onModuleDestroy();
    await pool.query("DROP SCHEMA IF EXISTS private_chat CASCADE");
    await pool.query("DELETE FROM public.users WHERE id IN ($1, $2)", [owner, stranger]);
    await pool.end();
    vi.unstubAllEnvs();
  });

  it("encrypts content and scopes every user operation", async () => {
    const id = randomUUID();
    await repository.create(owner, id, "private flood question", "private answer", "knowledge");
    expect(await repository.access(owner, id)).toBe("owned");
    expect(await repository.access(stranger, id)).toBe("other");
    expect((await repository.list(stranger, 20)).items).toEqual([]);
    expect(await repository.messages(stranger, id, 20)).toBeNull();
    expect(await repository.append(stranger, id, "attack", "attack", "knowledge")).toBe(false);
    expect(await repository.delete(stranger, id)).toBe(false);
    const raw = await pool.query("SELECT ciphertext FROM private_chat.messages WHERE session_id = $1", [id]);
    expect(raw.rows[0].ciphertext.toString("utf8")).not.toContain("private flood question");
    expect((await repository.messages(owner, id, 20))?.items[0].content).toBe("private flood question");
    await repository.delete(owner, id);
    expect((await pool.query("SELECT id FROM private_chat.messages WHERE session_id = $1", [id])).rows).toEqual([]);
  });

  it("pages older messages and rolls back a failed message pair", async () => {
    const id = randomUUID();
    await repository.create(owner, id, "question 0", "answer 0", "knowledge");
    for (let i = 1; i < 8; i++) await repository.append(owner, id, `question ${i}`, `answer ${i}`, "knowledge");
    const first = await repository.messages(owner, id, 5);
    expect(first?.items.map((item) => item.content)).toEqual([
      "answer 5", "question 6", "answer 6", "question 7", "answer 7",
    ]);
    expect(first?.nextCursor).toBeTruthy();
    const older = await repository.messages(owner, id, 5, first!.nextCursor!);
    expect(older?.items[0].content).toBe("question 3");
    await expect(repository.append(owner, id, "must rollback", "must rollback", "invalid" as never))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect((await repository.recent(owner, id, 50)).some((item) => item.content === "must rollback")).toBe(false);
    await repository.delete(owner, id);
  });

  it("loads only the newest assistant knowledge answers across a long session", async () => {
    const id = randomUUID();
    await repository.create(owner, id, "question 0", "knowledge answer 0", "knowledge");
    for (let i = 1; i < 8; i++) {
      const kind = i % 2 === 0 ? "knowledge" : "small_talk";
      await repository.append(owner, id, `question ${i}`, `answer ${i}`, kind);
    }
    for (let i = 8; i < 16; i++) {
      await repository.append(owner, id, `question ${i}`, `answer ${i}`, "small_talk");
    }

    const answers = await repository.recentKnowledgeAnswers(owner, id, 2);

    expect(answers).toEqual([
      { role: "assistant", content: "answer 4", kind: "knowledge" },
      { role: "assistant", content: "answer 6", kind: "knowledge" },
    ]);
    expect(await repository.recentKnowledgeAnswers(stranger, id, 2)).toEqual([]);
    await repository.delete(owner, id);
  });

  it("stores and returns action-kind assistant turns", async () => {
    const id = randomUUID();
    await repository.create(owner, id, "Xóa báo cáo 22", "Xác nhận trước khi xóa.", "action");

    const page = await repository.messages(owner, id, 20);

    expect(page?.items.map(({ role, kind, content }) => ({ role, kind, content }))).toEqual([
      { role: "user", kind: "action", content: "Xóa báo cáo 22" },
      { role: "assistant", kind: "action", content: "Xác nhận trước khi xóa." },
    ]);
    await repository.delete(owner, id);
  });

  it("pages sessions, derives titles on read, and rejects bad cursors", async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    await repository.create(owner, firstId, "first private title", "answer", "knowledge");
    await repository.create(owner, secondId, "second private title", "answer", "knowledge");
    const firstPage = await repository.list(owner, 1);
    const secondPage = await repository.list(owner, 1, firstPage.nextCursor!);
    expect(firstPage.items).toHaveLength(1);
    expect(secondPage.items).toHaveLength(1);
    expect(new Set([firstPage.items[0].sessionId, secondPage.items[0].sessionId]))
      .toEqual(new Set([firstId, secondId]));
    expect([firstPage.items[0].title, secondPage.items[0].title].sort())
      .toEqual(["first private title", "second private title"]);
    await expect(repository.list(owner, 1, "bad!")).rejects.toMatchObject({ status: 400 });
    await repository.delete(owner, firstId);
    await repository.delete(owner, secondId);
  });

  it("imports legacy turns encrypted and removes them with session deletion", async () => {
    const id = randomUUID();
    await repository.importLegacy(owner, id, [
      { role: "user", content: "legacy private text", kind: "legacy" },
      { role: "assistant", content: "legacy reply", kind: "legacy" },
    ], async () => true);
    const raw = await pool.query("SELECT ciphertext FROM private_chat.messages WHERE session_id = $1", [id]);
    expect(raw.rows[0].ciphertext.toString("utf8")).not.toContain("legacy private text");
    expect((await repository.messages(owner, id, 20))?.items[0].content).toBe("legacy private text");
    await repository.delete(owner, id);
    expect((await pool.query("SELECT id FROM private_chat.messages WHERE session_id = $1", [id])).rows).toEqual([]);
  });

  it("does not resurrect a legacy session when deletion wins the race", async () => {
    const id = randomUUID();
    let releaseDelete!: () => void;
    let deletionHasLock!: () => void;
    const waitToDelete = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const lockAcquired = new Promise<void>((resolve) => { deletionHasLock = resolve; });
    let legacyOwnerActive = true;
    const deleting = repository.delete(owner, id, async () => {
      deletionHasLock();
      await waitToDelete;
      legacyOwnerActive = false;
      return true;
    });
    await lockAcquired;
    const importing = repository.importLegacy(owner, id, [
      { role: "user", content: "must stay deleted", kind: "legacy" },
    ], async () => legacyOwnerActive);
    releaseDelete();
    await expect(deleting).resolves.toBe(true);
    await expect(importing).rejects.toMatchObject({ status: 404 });
    expect((await pool.query("SELECT id FROM private_chat.sessions WHERE id = $1", [id])).rows)
      .toEqual([]);
  });

  it("cascades account deletion and blocks direct Supabase client roles", async () => {
    const id = randomUUID();
    await repository.create(stranger, id, "account private", "reply", "knowledge");
    const role = await pool.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AS exists");
    if (!role.rows[0].exists) await pool.query("CREATE ROLE anon NOLOGIN");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE anon");
      await expect(client.query("SELECT * FROM private_chat.sessions LIMIT 1"))
        .rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    await pool.query("DELETE FROM public.users WHERE id = $1", [stranger]);
    expect((await pool.query("SELECT id FROM private_chat.sessions WHERE id = $1", [id])).rows).toEqual([]);
    expect((await pool.query("SELECT id FROM private_chat.messages WHERE session_id = $1", [id])).rows).toEqual([]);
  });

  it("re-encrypts old messages under a new key version", async () => {
    const id = randomUUID();
    await repository.create(owner, id, "rotation secret", "answer", "knowledge");
    const keyring = Buffer.from(JSON.stringify({
      V1: Buffer.alloc(32, 7).toString("base64"),
      V2: Buffer.alloc(32, 8).toString("base64"),
    })).toString("base64");
    execFileSync(process.execPath, [resolve("scripts/rotate-chat-history-key.js")], {
      env: { ...process.env, DATABASE_URL: testUrl, CHAT_KEYRING_B64: keyring, CHAT_KEY_CURRENT: "V2" },
      stdio: "pipe",
    });
    const rows = await pool.query("SELECT key_id FROM private_chat.messages WHERE session_id = $1", [id]);
    expect(rows.rows.map((row: { key_id: string }) => row.key_id)).toEqual(["V2", "V2"]);
    // The old repository keyring cannot decrypt V2; a new process uses both keys.
    vi.stubEnv("CHAT_KEYRING_B64", keyring);
    vi.stubEnv("CHAT_KEY_CURRENT", "V2");
    const rotatedCrypto = new ChatCryptoService();
    const newRepository = new ChatHistoryRepository(rotatedCrypto, logger as never);
    try {
      expect((await newRepository.messages(owner, id, 20))?.items[0].content).toBe("rotation secret");
    } finally {
      await newRepository.onModuleDestroy();
      await repository.delete(owner, id);
    }
  });
});
