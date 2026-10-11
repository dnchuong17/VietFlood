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
    expect(draft.answer).toContain("Bạn kiểm tra lại thông tin trước khi tiếp tục");
    expect(draft.answer).toContain("tỉnh/thành: Đà Nẵng");
    expect(draft.answer).not.toContain("actionId");
    expect(draft.answer).not.toContain("province:");
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
    expect(done.answer).toContain("Mình đã tạo báo cáo");
    expect(done.answer).toContain("mã: 14");
    expect(reports.createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        category: ["flood"],
        description: "Ngập đường",
      }),
      7,
      [],
    );
    expect(values.size).toBe(0);
  });

  it("collects missing report fields across turns and accepts corrections", async () => {
    gemini.understandAction
      .mockResolvedValueOnce({
        intent: "create_report",
        arguments: { category: ["flood"], description: "Ngập đường", province: "Đà Nẵng" },
      })
      .mockResolvedValueOnce({
        intent: "create_report",
        arguments: { ward: "Hải Châu", addressLine: "Đường A" },
      });

    const first = await service.handle(citizen, sessionId, "Tạo báo cáo ngập đường");
    expect(first.action?.status).toBe("collecting");
    expect(first.answer).toContain("phường/xã");
    expect(first.answer).toContain("địa chỉ");
    expect(reports.createReport).not.toHaveBeenCalled();

    const complete = await service.handle(citizen, sessionId, "Hải Châu, đường A");
    expect(complete.action?.status).toBe("awaiting_confirmation");
    expect(complete.action?.intent).toBe("create_report");
    expect(complete.answer).toContain("GPS: chưa cung cấp (tùy chọn)");
    expect(reports.createReport).not.toHaveBeenCalled();
  });

  it("rejects unsupported report categories and allows a correction", async () => {
    gemini.understandAction
      .mockResolvedValueOnce({
        intent: "create_report",
        arguments: { category: "earthquake", description: "Sự cố", province: "Đà Nẵng", ward: "Hải Châu", addressLine: "Đường A" },
      })
      .mockResolvedValueOnce({ intent: "create_report", arguments: { category: "incident" } });

    const invalid = await service.handle(citizen, sessionId, "Tạo báo cáo");
    expect(invalid.action?.status).toBe("collecting");
    expect(invalid.answer).toContain("Loại báo cáo chưa hợp lệ");
    const corrected = await service.handle(citizen, sessionId, "Sự cố");
    expect(corrected.action?.status).toBe("awaiting_confirmation");
    expect(corrected.answer).toContain("loại báo cáo: sự cố");
    expect(reports.createReport).not.toHaveBeenCalled();
  });

  it("passes optional coordinates and evidence only after confirmation", async () => {
    gemini.understandAction.mockResolvedValue({
      intent: "create_report",
      arguments: { category: "flood", description: "Ngập đường", province: "Đà Nẵng", ward: "Hải Châu", addressLine: "Đường A" },
    });
    const file = { originalname: "evidence.jpg", mimetype: "image/jpeg", buffer: Buffer.from("image") } as Express.Multer.File;

    const draft = await service.handle(citizen, sessionId, "Tạo báo cáo", undefined, undefined, {
      latitude: 16.05,
      longitude: 108.2,
    });
    expect(draft.answer).toContain("GPS: 16.05, 108.2");
    expect(reports.createReport).not.toHaveBeenCalled();

    const result = await service.handle(citizen, sessionId, "Xác nhận", draft.action?.id, "confirm", {}, [file]);
    expect(result.action?.status).toBe("completed");
    expect(reports.createReport).toHaveBeenCalledWith(
      expect.objectContaining({ category: ["flood"], lat: 16.05, lng: 108.2 }),
      citizen.userId,
      [file],
    );
  });

  it("rejects an incomplete GPS pair and supports omitting GPS", async () => {
    gemini.understandAction.mockResolvedValue({
      intent: "create_report",
      arguments: { category: "flood", description: "Ngập đường", province: "Đà Nẵng", ward: "Hải Châu", addressLine: "Đường A" },
    });
    const draft = await service.handle(citizen, sessionId, "Tạo báo cáo", undefined, undefined, { latitude: 16 });
    expect(draft.action?.status).toBe("collecting");
    expect(draft.answer).toContain("cả vĩ độ và kinh độ");

    const completed = await service.handle(citizen, sessionId, "Xác nhận", draft.action?.id, "confirm", { clearLocation: true });
    expect(completed.action?.status).toBe("completed");
    expect(reports.createReport).toHaveBeenCalledWith(expect.not.objectContaining({ lat: expect.anything(), lng: expect.anything() }), citizen.userId, []);
  });

  it("rejects replayed confirmations after one successful report creation", async () => {
    gemini.understandAction.mockResolvedValue({
      intent: "create_report",
      arguments: { category: "flood", description: "Ngập đường", province: "Đà Nẵng", ward: "Hải Châu", addressLine: "Đường A" },
    });
    const draft = await service.handle(citizen, sessionId, "Tạo báo cáo");
    await service.handle(citizen, sessionId, "Xác nhận", draft.action?.id, "confirm");
    await expect(service.handle(citizen, sessionId, "Xác nhận", draft.action?.id, "confirm")).rejects.toBeInstanceOf(BadRequestException);
    expect(reports.createReport).toHaveBeenCalledTimes(1);
  });

  it("exposes only the pending action ID and phase for an owned session", async () => {
    gemini.understandAction.mockResolvedValue({
      intent: "delete_report",
      arguments: { reportId: 22 },
    });
    const draft = await service.handle(citizen, sessionId, "Xóa báo cáo 22");

    await expect(service.pendingAction(citizen, sessionId)).resolves.toEqual({
      id: draft.action?.id,
      intent: "delete_report",
      status: "awaiting_confirmation",
    });
    await expect(
      service.pendingAction({ ...citizen, userId: 8 }, sessionId),
    ).resolves.toBeNull();
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
