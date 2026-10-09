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
  const gemini = { isConfigured: vi.fn(() => false), answer: vi.fn() };
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
    vi.stubEnv("GOOGLE_API_KEY", "");
    vi.stubEnv("QDRANT_CHAT_COLLECTION", "");
    service = new ChatService(
      redis as never,
      reports as never,
      knowledge as never,
      history as never,
      logger as never,
      gemini as never,
      actions as never,
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

  it("answers typoed capability questions without querying flood knowledge", async () => {
    const result = await service.reply(7, { message: "hỗ tợ gì" });
    expect(result.answer).toContain("sơ cứu cơ bản");
    expect(history.create).toHaveBeenCalledWith(7, result.sessionId, "hỗ tợ gì", result.answer, "small_talk");
    expect(knowledge.search).not.toHaveBeenCalled();
  });

  it("answers current flood location questions from verified area summaries", async () => {
    reports.getRecentVerifiedFloodAreas.mockResolvedValue([
      {
        province: "Đà Nẵng",
        ward: "Hải Châu",
        reportCount: 2,
        latestAt: "2026-10-09T06:00:00.000Z",
        addressLine: "1 private road",
        description: "private report detail",
      },
    ]);
    const result = await service.reply(7, { message: "lũ ở đâu?" });

    expect(result.answer).toContain("Hải Châu, Đà Nẵng");
    expect(result.answer).toContain("2 báo cáo");
    expect(result.answer).not.toContain("private");
    expect(history.create).toHaveBeenCalledWith(7, result.sessionId, "lũ ở đâu?", result.answer, "community_reports");
    expect(reports.getRecentVerifiedFloodAreas).toHaveBeenCalledOnce();
    expect(knowledge.search).not.toHaveBeenCalled();
  });

  it('routes "bây giờ lũ ở đâu" only to verified report summaries', async () => {
    reports.getRecentVerifiedFloodAreas.mockResolvedValue([]);

    const result = await service.reply(7, { message: "Bây giờ lũ ở đâu?" });

    expect(result.answer).toContain("Trong 24 giờ qua");
    expect(reports.getRecentVerifiedFloodAreas).toHaveBeenCalledOnce();
    expect(knowledge.search).not.toHaveBeenCalled();
    expect(gemini.answer).not.toHaveBeenCalled();
  });

  it("does not imply no flooding when there are no verified community reports", async () => {
    reports.getRecentVerifiedFloodAreas.mockResolvedValue([]);
    const result = await service.reply(7, { message: "lũ ở đâu?" });

    expect(result.answer).toContain("không có nghĩa là chắc chắn không có lũ");
    expect(history.create).toHaveBeenCalledWith(7, result.sessionId, "lũ ở đâu?", result.answer, "community_reports");
    expect(knowledge.search).not.toHaveBeenCalled();
  });

  it("answers report count questions from verified aggregate data", async () => {
    reports.getRecentVerifiedReportCount.mockResolvedValue(7);

    const result = await service.reply(7, { message: "Có bao nhiêu báo cáo lũ đã xác minh?" });

    expect(result.answer).toContain("7 báo cáo lũ/ngập đã được xác minh");
    expect(reports.getRecentVerifiedReportCount).toHaveBeenCalledWith("flood");
    expect(knowledge.search).not.toHaveBeenCalled();
    expect(gemini.answer).not.toHaveBeenCalled();
  });

  it("does not invent report counts when the Reports service is unavailable", async () => {
    reports.getRecentVerifiedReportCount.mockRejectedValue(new Error("reports service offline"));

    await expect(service.reply(7, { message: "Thống kê báo cáo cứu hộ" }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(reports.getRecentVerifiedReportCount).toHaveBeenCalledWith("rescue");
    expect(knowledge.search).not.toHaveBeenCalled();
  });

  it("returns a service error instead of inventing flood locations when reports are unavailable", async () => {
    reports.getRecentVerifiedFloodAreas.mockRejectedValue(new Error("reports service offline"));

    await expect(service.reply(7, { message: "lũ ở đâu?" }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(knowledge.search).not.toHaveBeenCalled();
    expect(history.create).not.toHaveBeenCalled();
  });

  it("logs safe report RPC timeout diagnostics without logging error details", async () => {
    reports.getRecentVerifiedFloodAreas.mockRejectedValue(new Error("TimeoutError: private payload timed out"));

    await expect(service.reply(7, { message: "Bây giờ lũ ở đâu?" }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(logger.warn).toHaveBeenCalledWith("Recent flood report RPC timed out");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private payload");
  });

  it("keeps general flood location questions on the knowledge path", async () => {
    knowledge.search.mockResolvedValue(["Các vùng thường có lũ quét gồm vùng núi dốc."]);
    const result = await service.reply(7, { message: "Những vùng nào thường có lũ?" });

    expect(result.answer).toContain("vùng núi dốc");
    expect(knowledge.search).toHaveBeenCalledOnce();
    expect(reports.getRecentVerifiedFloodAreas).not.toHaveBeenCalled();
  });

  it("does not let a greeting swallow a substantive flood question", async () => {
    knowledge.search.mockResolvedValue(["Lũ quét có thể xảy ra nhanh sau mưa lớn."]);
    const result = await service.reply(7, { message: "Hi, lũ quét nguy hiểm thế nào?" });

    expect(result.answer).toContain("Lũ quét có thể xảy ra nhanh");
    expect(knowledge.search).toHaveBeenCalledOnce();
  });

  it("uses a local passage and strips links from the response", async () => {
    knowledge.search.mockResolvedValue(["Lũ quét xảy ra nhanh. https://example.com/source"]);
    const result = await service.reply(7, { message: "Lũ quét là gì?" });
    expect(result.answer).toContain("Lũ quét xảy ra nhanh");
    expect(result.answer).not.toContain("https://");
    expect(sessions.get(result.sessionId)?.turns[0].kind).toBe("knowledge");
  });

  it("shortens local passages at a sentence boundary within 400 characters", async () => {
    const firstSentence = "A".repeat(120) + ".";
    knowledge.search.mockResolvedValue([`${firstSentence} ${"B".repeat(500)}`]);

    const result = await service.reply(7, { message: "Cách phòng lũ?" });
    const excerpt = result.answer.slice("Theo kho kiến thức VietFlood: ".length);

    expect(excerpt).toBe(firstSentence);
    expect(excerpt.length).toBeLessThanOrEqual(400);
  });

  it("shortens an overlong first sentence at a word boundary with an ellipsis", async () => {
    const passage = `${"từ ".repeat(150)}cuối cùng trong câu dài không có dấu kết thúc`;
    knowledge.search.mockResolvedValue([passage]);

    const result = await service.reply(7, { message: "Cách phòng lũ?" });
    const excerpt = result.answer.slice("Theo kho kiến thức VietFlood: ".length);

    expect(excerpt.length).toBeLessThanOrEqual(400);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).not.toMatch(/\s…$/u);
  });

  it("uses Gemini only with passages from the approved collection", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "test-secret");
    vi.stubEnv("QDRANT_CHAT_COLLECTION", "flood_kb_approved");
    gemini.isConfigured.mockReturnValue(true);
    knowledge.search.mockResolvedValue(["staging passage"]);
    knowledge.searchApproved.mockResolvedValue(["approved passage"]);
    gemini.answer.mockResolvedValue("Câu trả lời đã tổng hợp.");

    const result = await service.reply(7, { message: "Cách chuẩn bị trước lũ?" });

    expect(knowledge.searchApproved).toHaveBeenCalledWith("Cách chuẩn bị trước lũ?");
    expect(gemini.answer).toHaveBeenCalledWith("Cách chuẩn bị trước lũ?", ["approved passage"], []);
    expect(result.answer).toBe("Câu trả lời đã tổng hợp.");
    expect(history.create).toHaveBeenCalledWith(7, result.sessionId, "Cách chuẩn bị trước lũ?", result.answer, "knowledge");
  });

  it("passes only two prior assistant knowledge answers for a follow-up", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "test-secret");
    vi.stubEnv("QDRANT_CHAT_COLLECTION", "flood_kb_approved");
    gemini.isConfigured.mockReturnValue(true);
    knowledge.search.mockResolvedValue(["local passage"]);
    knowledge.searchApproved.mockResolvedValue(["approved passage"]);
    gemini.answer.mockResolvedValue("Câu trả lời tiếp nối.");
    const first = await service.reply(7, { message: "Cần chuẩn bị gì trước lũ?" });
    sessions.get(first.sessionId)!.turns = [
      { role: "user", content: "do not send this", kind: "knowledge" },
      { role: "assistant", content: "Trả lời cũ nhất", kind: "knowledge" },
      { role: "user", content: "private report question", kind: "report_status" },
      { role: "assistant", content: "Chi tiết báo cáo riêng", kind: "report_status" },
      { role: "assistant", content: "Trả lời kiến thức gần nhất 1", kind: "knowledge" },
      { role: "assistant", content: "Trả lời kiến thức gần nhất 2", kind: "knowledge" },
    ];

    await service.reply(7, { message: "Còn nước uống thì sao?", sessionId: first.sessionId });

    expect(gemini.answer).toHaveBeenLastCalledWith("Còn nước uống thì sao?", ["approved passage"], [
      { role: "assistant", content: "Trả lời kiến thức gần nhất 1" },
      { role: "assistant", content: "Trả lời kiến thức gần nhất 2" },
    ]);
    expect(history.recentKnowledgeAnswers).toHaveBeenCalledWith(7, first.sessionId, 2);
  });

  it("finds knowledge context beyond the ordinary recent-turn window", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "test-secret");
    vi.stubEnv("QDRANT_CHAT_COLLECTION", "flood_kb_approved");
    gemini.isConfigured.mockReturnValue(true);
    knowledge.search.mockResolvedValue(["local passage"]);
    knowledge.searchApproved.mockResolvedValue(["approved passage"]);
    gemini.answer.mockResolvedValue("Câu trả lời tiếp nối.");
    const first = await service.reply(7, { message: "Những việc cần làm trước lũ?" });
    sessions.get(first.sessionId)!.turns = [
      { role: "assistant", content: "Ngữ cảnh knowledge xa hơn", kind: "knowledge" },
      ...Array.from({ length: 14 }, (_, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `Nội dung khác ${index}`,
        kind: "small_talk" as const,
      })),
      { role: "assistant", content: "Ngữ cảnh knowledge mới hơn", kind: "knowledge" },
      ...Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `Nội dung xen giữa ${index}`,
        kind: "small_talk" as const,
      })),
    ];

    await service.reply(7, { message: "Còn nước uống thì sao?", sessionId: first.sessionId });

    expect(history.recent).toHaveBeenCalledWith(7, first.sessionId, 10);
    expect(gemini.answer).toHaveBeenLastCalledWith("Còn nước uống thì sao?", ["approved passage"], [
      { role: "assistant", content: "Ngữ cảnh knowledge xa hơn" },
      { role: "assistant", content: "Ngữ cảnh knowledge mới hơn" },
    ]);
  });

  it.each(["Còn nước uống thì sao?", "Thế còn trẻ em?", "What about children?", "Bao lâu?"])(
    "recognizes follow-up phrasing: %s",
    async (message) => {
      vi.stubEnv("GOOGLE_API_KEY", "test-secret");
      vi.stubEnv("QDRANT_CHAT_COLLECTION", "flood_kb_approved");
      gemini.isConfigured.mockReturnValue(true);
      knowledge.search.mockResolvedValue(["local passage"]);
      knowledge.searchApproved.mockResolvedValue(["approved passage"]);
      gemini.answer.mockResolvedValue("Câu trả lời tiếp nối.");
      const first = await service.reply(7, { message: "Cần chuẩn bị gì trước lũ?" });

      await service.reply(7, { message, sessionId: first.sessionId });

      expect(history.recentKnowledgeAnswers).toHaveBeenCalledWith(7, first.sessionId, 2);
      expect(gemini.answer).toHaveBeenLastCalledWith(
        message,
        ["approved passage"],
        [{ role: "assistant", content: "Câu trả lời tiếp nối." }],
      );
    },
  );

  it("asks for context instead of searching when a follow-up has no prior knowledge answer", async () => {
    const result = await service.reply(7, { message: "What about children?" });

    expect(result.answer).toContain("chưa thấy ngữ cảnh trước đó");
    expect(result.answer).toContain("chủ đề nào");
    expect(result.sessionId).toBeTruthy();
    expect(knowledge.search).not.toHaveBeenCalled();
    expect(knowledge.searchApproved).not.toHaveBeenCalled();
    expect(gemini.answer).not.toHaveBeenCalled();
    expect(history.create).toHaveBeenCalledWith(7, result.sessionId, "What about children?", result.answer, "fallback");
  });

  it("does not call Gemini without an approved passage and falls back locally", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "test-secret");
    vi.stubEnv("QDRANT_CHAT_COLLECTION", "flood_kb_approved");
    gemini.isConfigured.mockReturnValue(true);
    knowledge.search.mockResolvedValue(["staging local passage"]);
    knowledge.searchApproved.mockResolvedValue([]);

    const result = await service.reply(7, { message: "Cách chuẩn bị trước lũ?" });

    expect(gemini.answer).not.toHaveBeenCalled();
    expect(result.answer).toContain("staging local passage");
  });

  it("falls back locally when Gemini returns no answer", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "test-secret");
    vi.stubEnv("QDRANT_CHAT_COLLECTION", "flood_kb_approved");
    gemini.isConfigured.mockReturnValue(true);
    knowledge.search.mockResolvedValue(["local passage"]);
    knowledge.searchApproved.mockResolvedValue(["approved passage"]);
    gemini.answer.mockResolvedValue(null);

    const result = await service.reply(7, { message: "Cách chuẩn bị trước lũ?" });

    expect(result.answer).toContain("local passage");
    expect(result.answer).not.toContain("approved passage");
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
