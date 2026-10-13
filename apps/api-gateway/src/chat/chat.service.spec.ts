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
  const reports = {
    getAllReportsById: vi.fn(),
    getRecentVerifiedFloodAreas: vi.fn(),
    getRecentVerifiedReportCount: vi.fn(),
  };
  const knowledge = { search: vi.fn(), searchApproved: vi.fn() };
  const ollama = {
    isConfigured: vi.fn(() => false),
    configurationStatus: vi.fn((): "ready" | "missing_model_configuration" =>
      ollama.isConfigured() ? "ready" : "missing_model_configuration",
    ),
    answer: vi.fn(),
  };
  const actions = {
    handle: vi.fn(async () => ({ handled: false })),
    pendingAction: vi.fn(async () => null),
  };
  const history = {
    access: vi.fn(async (userId: number, id: string) => {
      const session = sessions.get(id);
      return session ? (session.userId === userId ? "owned" : "other") : "missing";
    }),
    recent: vi.fn(async (_userId: number, id: string, limit: number) =>
      sessions.get(id)?.turns.slice(-limit) ?? []),
    recentKnowledgeAnswers: vi.fn(async (_userId: number, id: string, limit = 2) =>
      (sessions.get(id)?.turns ?? [])
        .filter((turn) => turn.role === "assistant" && turn.kind === "knowledge")
        .slice(-limit)),
    recentKnowledgeQuestions: vi.fn(async (_userId: number, id: string, limit = 2) =>
      (sessions.get(id)?.turns ?? [])
        .filter((turn) => turn.role === "user" && turn.kind === "knowledge")
        .slice(-limit)),
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
  const rag = { reply: vi.fn(async () => ({ answer: "Câu trả lời có nguồn.", status: "answered", sources: [], generationMode: "grounded_synthesis", unansweredParts: [] })) };
  const logger = { setServiceName: vi.fn(), info: vi.fn(), warn: vi.fn() };
  let service: ChatService;

  beforeEach(() => {
    sessions.clear();
    cache.clear();
    requestCount = 0;
    vi.clearAllMocks();

    vi.stubEnv("QDRANT_CHAT_COLLECTION", "");
    service = new ChatService(
      redis as never,
      reports as never,
      knowledge as never,
      history as never,
      logger as never,
      ollama as never,
      actions as never,
      rag as never,
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

  it("returns an actor-owned pending action with the conversation history", async () => {
    actions.pendingAction.mockResolvedValueOnce({
      id: "c8b9637e-6109-4c45-bd5f-02f38389a3ce",
      status: "awaiting_confirmation",
    });
    const first = await service.reply(7, { message: "Cách tạo báo cáo?" });

    const page = await service.listMessages(
      { userId: 7, role: "citizen", username: "citizen" },
      first.sessionId,
    );

    expect(page.pendingAction).toEqual({
      id: "c8b9637e-6109-4c45-bd5f-02f38389a3ce",
      status: "awaiting_confirmation",
    });
    expect(actions.pendingAction).toHaveBeenCalledWith(
      { userId: 7, role: "citizen", username: "citizen" },
      first.sessionId,
    );
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

  it("stores citations inside the encrypted answer payload and returns them to the client", async () => {
    rag.reply.mockResolvedValueOnce({ answer: "Có nguồn [1]", status: "answered", sources: [{ id: "p1", citation: 1, documentId: "E01", version: 1, title: "Nguồn", sourceUrl: "https://example.com", snapshotUrl: "/chat/sources/E01/versions/1", sectionPath: [], chunkHash: "hash" }], generationMode: "grounded_synthesis", sourceSupportPercent: 100, unansweredParts: [] } as never);
    const response = await service.reply(7, { message: "Chuẩn bị trước lũ?" });
    expect(response.sources?.[0].documentId).toBe("E01");
    const stored = JSON.parse(history.create.mock.calls[0][3]);
    expect(stored).toMatchObject({ _vietfloodRag: 1, answer: response.answer, details: { sources: response.sources } });
  });

  it.each(["sơ cứu chảy máu", "Cách tạo báo cáo?", "bây giờ lũ ở đâu", "Chào bạn, cần chuẩn bị trước lũ thế nào?"])("routes knowledge/scope to RAG without local canned answers: %s", async message => {
    const result = await service.reply(7, { message });
    expect(rag.reply).toHaveBeenCalledWith(message, []);
    expect(result.answer).toBe("Câu trả lời có nguồn.");
    expect(reports.getRecentVerifiedFloodAreas).not.toHaveBeenCalled();
    expect(knowledge.search).not.toHaveBeenCalled();
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
