import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";

import { ChatService } from "./chat.service";
import { ChatTurn } from "./chat-history.repository";

describe("ChatService", () => {
  const sessions = new Map<string, { userId: number; turns: ChatTurn[] }>();
  const cache = new Map<string, string>();
  let requestCount = 0;
  const redis = {
    get: vi.fn(async (key: string) => cache.get(key) ?? null),
    del: vi.fn(async (key: string) => Number(cache.delete(key))),
    getClient: vi.fn(() => ({
      multi: () => ({
        incr: () => ({
          expire: () => ({
            exec: async () => [[null, ++requestCount], [null, 1]],
          }),
        }),
      }),
    })),
  };
  const reports = { getAllReportsById: vi.fn() };
  const knowledge = { search: vi.fn() };
  const history = {
    access: vi.fn(async (userId: number, id: string) => {
      const session = sessions.get(id);
      return session ? (session.userId === userId ? "owned" : "other") : "missing";
    }),
    recent: vi.fn(async (_userId: number, id: string, limit: number) =>
      sessions.get(id)?.turns.slice(-limit) ?? []),
    create: vi.fn(async (userId: number, id: string, message: string, answer: string, kind: ChatTurn["kind"]) => {
      sessions.set(id, { userId, turns: [
        { role: "user", content: message, kind },
        { role: "assistant", content: answer, kind },
      ] });
    }),
    append: vi.fn(async (userId: number, id: string, message: string, answer: string, kind: ChatTurn["kind"]) => {
      const session = sessions.get(id);
      if (!session || session.userId !== userId) return false;
      session.turns.push({ role: "user", content: message, kind }, { role: "assistant", content: answer, kind });
      return true;
    }),
    importLegacy: vi.fn(async (userId: number, id: string, turns: ChatTurn[], ownerStillActive: () => Promise<boolean>) => {
      if (!(await ownerStillActive())) throw new NotFoundException("Chat session not found");
      sessions.set(id, { userId, turns });
    }),
    list: vi.fn(async (userId: number) => ({ items: [...sessions.entries()]
      .filter(([, value]) => value.userId === userId)
      .map(([sessionId]) => ({ sessionId })), nextCursor: null })),
    messages: vi.fn(async (userId: number, id: string) => {
      const session = sessions.get(id);
      return session?.userId === userId ? {
        session: { sessionId: id },
        items: session.turns,
        nextCursor: null,
      } : null;
    }),
    delete: vi.fn(async (userId: number, id: string, eraseLegacy?: (exists: boolean) => Promise<boolean>) => {
      const session = sessions.get(id);
      if (session && session.userId !== userId) return false;
      const legacyOwned = eraseLegacy ? await eraseLegacy(Boolean(session)) : false;
      return (session ? sessions.delete(id) : false) || legacyOwned;
    }),
  };
  const logger = { setServiceName: vi.fn(), warn: vi.fn() };
  let service: ChatService;

  beforeEach(() => {
    sessions.clear();
    cache.clear();
    requestCount = 0;
    vi.clearAllMocks();
    service = new ChatService(
      redis as never,
      reports as never,
      knowledge as never,
      history as never,
      logger as never,
    );
  });

  it("stores complete conversations and resumes after Redis expiry", async () => {
    const first = await service.reply(7, { message: "Cách tạo báo cáo?" });
    expect(first.sessionId).toBeTruthy();
    expect(cache.size).toBe(0);
    for (let i = 0; i < 6; i++) {
      await service.reply(7, { message: "Cách tạo báo cáo?", sessionId: first.sessionId });
    }
    expect(sessions.get(first.sessionId)?.turns).toHaveLength(14);
    expect(history.recent).toHaveBeenCalledWith(7, first.sessionId, 10);
    expect((await service.listMessages(7, first.sessionId)).items).toHaveLength(14);
  });

  it("rejects another account across reply, read, list and delete", async () => {
    const first = await service.reply(7, { message: "Cách tạo báo cáo?" });
    await expect(service.reply(8, { message: "Xin chào", sessionId: first.sessionId }))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.listMessages(8, first.sessionId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.deleteSession(8, first.sessionId)).rejects.toBeInstanceOf(NotFoundException);
    expect((await service.listSessions(8)).items).toEqual([]);
    expect(sessions.has(first.sessionId)).toBe(true);
  });

  it("imports an active legacy session only for its owner", async () => {
    const id = "d42639bf-a048-4e4f-b55f-23ef0f97d207";
    cache.set(`chat:owner:${id}`, "7");
    cache.set(`chat:session:7:${id}`, JSON.stringify([
      { role: "user", content: "Cách tạo báo cáo?" },
      { role: "assistant", content: "Dùng biểu mẫu." },
    ]));
    await expect(service.listMessages(8, id)).rejects.toBeInstanceOf(NotFoundException);
    const result = await service.listMessages(7, id);
    expect(result.items).toHaveLength(2);
    expect(history.importLegacy).toHaveBeenCalledOnce();
    expect(cache.size).toBe(0);
  });

  it("hard-deletes a conversation and prevents reopening", async () => {
    const first = await service.reply(7, { message: "Cách tạo báo cáo?" });
    await service.deleteSession(7, first.sessionId);
    expect(sessions.has(first.sessionId)).toBe(false);
    await expect(service.listMessages(7, first.sessionId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("reads report status only for the authenticated user", async () => {
    reports.getAllReportsById.mockResolvedValue([{ id: 11, status: "verified" }]);
    const result = await service.reply(7, { message: "Trạng thái báo cáo 12?" });
    expect(reports.getAllReportsById).toHaveBeenCalledWith(7);
    expect(result.answer).toContain("không tìm thấy báo cáo #12");
    expect(sessions.get(result.sessionId)?.turns[0].kind).toBe("report_status");
  });

  it("returns reviewed first aid locally without sending text to Qdrant or Gemini", async () => {
    const result = await service.reply(7, { message: "Sơ cứu chảy máu thế nào?" });
    expect(result.answer).toContain("ép trực tiếp");
    expect(knowledge.search).not.toHaveBeenCalled();
  });

  it("uses a local passage and strips links from the response", async () => {
    knowledge.search.mockResolvedValue(["Lũ quét xảy ra nhanh. https://example.com/source"]);
    const result = await service.reply(7, { message: "Lũ quét là gì?" });
    expect(result.answer).toContain("Lũ quét xảy ra nhanh");
    expect(result.answer).not.toContain("https://");
    expect(sessions.get(result.sessionId)?.turns[0].kind).toBe("knowledge");
  });

  it("returns safe errors for knowledge and database failures without logging content", async () => {
    knowledge.search.mockRejectedValue(new ServiceUnavailableException("Knowledge base is unavailable"));
    await expect(service.reply(7, { message: "private flood question" }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    knowledge.search.mockResolvedValue([]);
    history.create.mockRejectedValueOnce(new ServiceUnavailableException("Chat history is unavailable"));
    await expect(service.reply(7, { message: "private flood question" }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private flood question");
  });

  it("limits chat requests to 20 per user per minute", async () => {
    for (let i = 0; i < 20; i++) await service.reply(7, { message: "Cách tạo báo cáo?" });
    await expect(service.reply(7, { message: "Cách tạo báo cáo?" }))
      .rejects.toMatchObject({ status: 429 });
  });

  it("keeps chat unavailable during a restore", async () => {
    vi.stubEnv("CHAT_HISTORY_ENABLED", "false");
    try {
      await expect(service.reply(7, { message: "Cách tạo báo cáo?" }))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(service.listSessions(7))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
