import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";

const modelInvoke = vi.hoisted(() => vi.fn());
vi.mock("@langchain/google/node", () => ({
  ChatGoogle: class {
    invoke = modelInvoke;
  },
}));

import { ChatService } from "./chat.service";

describe("ChatService", () => {
  const cache = new Map<string, string>();
  let requestCount = 0;
  const redis = {
    get: vi.fn(async (key: string) => cache.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      cache.set(key, value);
    }),
    getClient: vi.fn(() => ({
      multi: () => ({
        incr: () => ({
          expire: () => ({
            exec: async () => [
              [null, ++requestCount],
              [null, 1],
            ],
          }),
        }),
      }),
    })),
  };
  const reports = { getAllReportsById: vi.fn() };
  const knowledge = { search: vi.fn() };
  const logger = { setServiceName: vi.fn(), warn: vi.fn() };
  let service: ChatService;

  beforeEach(() => {
    cache.clear();
    requestCount = 0;
    vi.clearAllMocks();
    delete process.env.GOOGLE_API_KEY;
    service = new ChatService(
      redis as never,
      reports as never,
      knowledge as never,
      logger as never,
    );
  });

  it("keeps sessions per user and rejects another account", async () => {
    knowledge.search.mockResolvedValue([]);
    const first = await service.reply(7, { message: "Lũ quét là gì?" });
    expect(first.sessionId).toBeTruthy();
    expect(redis.set).toHaveBeenCalledWith(
      `chat:owner:${first.sessionId}`,
      "7",
      86400,
    );
    await expect(
      service.reply(8, { message: "Xin chào", sessionId: first.sessionId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("reads only the authenticated user's report statuses", async () => {
    reports.getAllReportsById.mockResolvedValue([
      { id: 11, status: "verified" },
    ]);
    const result = await service.reply(7, {
      message: "Trạng thái báo cáo 12?",
    });
    expect(reports.getAllReportsById).toHaveBeenCalledWith(7);
    expect(result.answer).toContain("không tìm thấy báo cáo #12");
    expect(result.answer).not.toContain("verified");
  });

  it("uses reviewed first aid guidance when the collection has no match", async () => {
    knowledge.search.mockResolvedValue([]);
    const result = await service.reply(7, {
      message: "Sơ cứu chảy máu thế nào?",
    });
    expect(result.answer).toContain("ép trực tiếp");
    expect(result.answer).toContain("gọi cấp cứu");
  });

  it("keeps follow-up turns in the Gemini prompt", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    knowledge.search.mockResolvedValue(["Lũ quét xảy ra nhanh ở vùng dốc."]);
    modelInvoke.mockResolvedValue({ text: "Đó là lũ xuất hiện nhanh." });
    const first = await service.reply(7, { message: "Lũ quét là gì?" });
    await service.reply(7, {
      message: "Nó nguy hiểm thế nào?",
      sessionId: first.sessionId,
    });
    const secondPrompt = modelInvoke.mock.calls[1][0];
    expect(
      secondPrompt.some(
        (item: { content: string }) => item.content === "Lũ quét là gì?",
      ),
    ).toBe(true);
    expect(
      secondPrompt.some(
        (item: { content: string }) => item.content === first.answer,
      ),
    ).toBe(true);
    expect(secondPrompt[0].content).toContain(
      "Mặc định trả lời ngắn gọn bằng tiếng Việt",
    );
  });

  it("reports knowledge and Redis failures clearly", async () => {
    knowledge.search.mockRejectedValue(
      new ServiceUnavailableException("Knowledge base is unavailable"),
    );
    await expect(
      service.reply(7, { message: "Nguyên nhân lũ lụt?" }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const firstAid = await service.reply(7, {
      message: "Cách sơ cứu người bị hạ thân nhiệt?",
    });
    expect(firstAid.answer).toContain("Làm ấm từ từ");
    redis.set.mockRejectedValueOnce(new Error("Redis down"));
    await expect(
      service.reply(7, { message: "Cách tạo báo cáo?" }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("returns a service error when Gemini fails", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    knowledge.search.mockResolvedValue(["Lũ là nước dâng cao."]);
    modelInvoke.mockRejectedValue(new Error("Gemini down"));
    await expect(
      service.reply(7, { message: "Lũ là gì?" }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("limits expensive chat requests per user", async () => {
    knowledge.search.mockResolvedValue([]);
    for (let index = 0; index < 20; index++) {
      await service.reply(7, { message: "Lũ là gì?" });
    }
    await expect(
      service.reply(7, { message: "Lũ là gì?" }),
    ).rejects.toMatchObject({ status: 429 });
  });
});
