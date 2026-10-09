import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { ChatActionService } from "./chat-action.service";

describe("ChatActionService", () => {
  const values = new Map<string, string>();
  const locks = new Set<string>();
  const redis = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => Number(values.delete(key))),
    getClient: vi.fn(() => ({
      set: async (key: string) => {
        if (locks.has(key)) return null;
        locks.add(key);
        return "OK";
      },
    })),
  };
  const reports = {
    createReport: vi.fn(async () => ({ id: 14 })),
    updateReport: vi.fn(),
    deleteReport: vi.fn(),
    updateReportStatus: vi.fn(),
    getAllReportsById: vi.fn(async () => []),
    getAllReports: vi.fn(async () => []),
  };
  const auth = {
    profile: vi.fn(),
    updateProfile: vi.fn(),
    getAllUsers: vi.fn(),
    getUserById: vi.fn(),
    updateUserById: vi.fn(),
    deleteUser: vi.fn(),
  };
  const gemini = { understandAction: vi.fn() };
  const logger = { warn: vi.fn() };
  const crypto = {
    encrypt: vi.fn((content: string) => ({
      ciphertext: Buffer.from(content),
      nonce: Buffer.alloc(12),
      authTag: Buffer.alloc(16),
      keyId: "test",
    })),
    decrypt: vi.fn((value: { ciphertext: Buffer }) =>
      value.ciphertext.toString("utf8"),
    ),
  };
  let service: ChatActionService;
  const citizen = { userId: 7, role: "citizen", username: "citizen" };
  const sessionId = "c8b9637e-6109-4c45-bd5f-02f38389a3ce";

  beforeEach(() => {
    values.clear();
    locks.clear();
    vi.clearAllMocks();
    vi.stubEnv("GOOGLE_API_KEY", "test-key");
    service = new ChatActionService(
      redis as never,
      reports as never,
      auth as never,
      gemini as never,
      logger as never,
      crypto as never,
    );
  });

  it("keeps a report draft encrypted and does not write until confirmation", async () => {
    gemini.understandAction.mockResolvedValue({
      intent: "create_report",
      arguments: {
        category: "flood",
        description: "Ngập đường",
        province: "Đà Nẵng",
        ward: "Hải Châu",
        addressLine: "Đường A",
      },
    });

    const draft = await service.handle(
      citizen,
      sessionId,
      "Tạo báo cáo ngập đường",
    );
    expect(draft.action?.status).toBe("awaiting_confirmation");
    expect(reports.createReport).not.toHaveBeenCalled();
    const raw = [...values.values()][0];
    expect(raw).not.toContain("Đà Nẵng");

    const done = await service.handle(
      citizen,
      sessionId,
      "Xác nhận",
      draft.action?.id,
      "confirm",
    );
    expect(done.action?.status).toBe("completed");
    expect(reports.createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        category: ["flood"],
        description: "Ngập đường",
      }),
      7,
    );
    expect(values.size).toBe(0);
  });

  it("rejects unauthorized staff operations before calling a service", async () => {
    gemini.understandAction.mockResolvedValue({
      intent: "all_reports",
      arguments: {},
    });
    const result = await service.handle(
      citizen,
      sessionId,
      "Liệt kê tất cả báo cáo",
    );
    expect(result.answer).toContain("không có quyền");
    expect(reports.getAllReports).not.toHaveBeenCalled();
  });

  it("rejects unknown or expired confirmation IDs", async () => {
    await expect(
      service.handle(
        citizen,
        sessionId,
        "xác nhận",
        "c8b9637e-6109-4c45-bd5f-02f38389a3ce",
        "confirm",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("does not send ordinary knowledge questions to the action classifier", async () => {
    const result = await service.handle(citizen, sessionId, "Lũ quét là gì?");
    expect(result.handled).toBe(false);
    expect(gemini.understandAction).not.toHaveBeenCalled();
  });

  it("cancels a proposed write without calling the mutation service", async () => {
    gemini.understandAction.mockResolvedValue({
      intent: "delete_report",
      arguments: { reportId: 22 },
    });
    const draft = await service.handle(citizen, sessionId, "Xóa báo cáo 22");
    const result = await service.handle(
      citizen,
      sessionId,
      "Hủy",
      draft.action?.id,
      "cancel",
    );
    expect(result.action?.status).toBe("cancelled");
    expect(reports.deleteReport).not.toHaveBeenCalled();
  });

  it("prevents a second write after the pending action has been consumed", async () => {
    gemini.understandAction.mockResolvedValue({
      intent: "delete_report",
      arguments: { reportId: 22 },
    });
    const draft = await service.handle(citizen, sessionId, "Xóa báo cáo 22");
    await service.handle(
      citizen,
      sessionId,
      "xác nhận",
      draft.action?.id,
      "confirm",
    );
    await expect(
      service.handle(
        citizen,
        sessionId,
        "xác nhận",
        draft.action?.id,
        "confirm",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(reports.deleteReport).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate confirmation while an action is still pending", async () => {
    gemini.understandAction.mockResolvedValue({
      intent: "delete_report",
      arguments: { reportId: 22 },
    });
    const draft = await service.handle(citizen, sessionId, "Xóa báo cáo 22");
    locks.add("chat:action-lock:" + draft.action?.id);
    await expect(
      service.handle(
        citizen,
        sessionId,
        "xác nhận",
        draft.action?.id,
        "confirm",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(reports.deleteReport).not.toHaveBeenCalled();
  });
});
