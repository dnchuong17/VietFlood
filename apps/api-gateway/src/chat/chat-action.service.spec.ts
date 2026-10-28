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
  const ollama = { understandAction: vi.fn(), isConfigured: vi.fn(() => true) };
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
    ollama.isConfigured.mockReturnValue(true);
    service = new ChatActionService(
      redis as never,
      reports as never,
      auth as never,
      ollama as never,
      logger as never,
      crypto as never,
    );
  });

  it("keeps a report draft encrypted and does not write until confirmation", async () => {
    ollama.understandAction.mockResolvedValue({
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
    ollama.understandAction
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
    expect(complete.answer).toContain("phường/xã: Hải Châu;");
    expect(complete.answer).not.toContain("Hải Châu, đường A");
    expect(reports.createReport).not.toHaveBeenCalled();
  });

  it.each(["null", "none", "blank", "unconfigured"])("preserves the pending report on %s extraction", async (mode) => {
    ollama.understandAction.mockResolvedValueOnce({
      intent: "create_report",
      arguments: { category: ["flood"], description: "Ngập đường", province: "TP.HCM", addressLine: "Đường A" },
    });
    const draft = await service.handle(citizen, sessionId, "Tạo báo cáo");
    ollama.isConfigured.mockReturnValue(mode !== "unconfigured");
    ollama.understandAction.mockResolvedValue(mode === "null" ? null : {
      intent: mode === "none" ? "none" : "create_report",
      arguments: { category: [], description: "  ", province: undefined, addressLine: "" },
    });
    const next = await service.handle(citizen, sessionId, "Phường Bùi Đình Túy");
    expect(next.handled).toBe(true);
    expect(next.action).toEqual({ id: draft.action?.id, intent: "create_report", status: "awaiting_confirmation" });
    expect(next.answer).toContain("Bùi Đình Túy");
    expect(next.answer).toContain("Ngập đường");
    expect(next.answer).toContain("TP.HCM");
    expect(next.answer).toContain("Đường A");
    expect(reports.createReport).not.toHaveBeenCalled();
  });

  it.each([false, true])("creates a report field by field without a working provider (configured=%s)", async (configured) => {
    ollama.isConfigured.mockReturnValue(configured);
    ollama.understandAction.mockResolvedValue(null);
    let draft = await service.handle(citizen, sessionId, "Tôi muốn tạo báo cáo");
    expect(draft.action?.status).toBe("collecting");
    for (const reply of ["ngập lụt", "Mô tả: Ngập đường sau mưa", "TP.HCM", "Phường Bùi Đình Túy", "Địa chỉ: 12 Đường A"]) {
      draft = await service.handle(citizen, sessionId, reply);
      expect(draft.handled).toBe(true);
      expect(reports.createReport).not.toHaveBeenCalled();
    }
    expect(draft.action?.status).toBe("awaiting_confirmation");
    expect(draft.answer).toContain("Bùi Đình Túy");
    expect(redis.set).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), 900);
    expect(crypto.encrypt).toHaveBeenCalled();
    const done = await service.handle(citizen, sessionId, "Xác nhận", draft.action?.id, "confirm");
    expect(done.action?.status).toBe("completed");
    expect(reports.createReport).toHaveBeenCalledExactlyOnceWith({
      category: ["flood"], description: "Ngập đường sau mưa", province: "TP.HCM", ward: "Phường Bùi Đình Túy", addressLine: "12 Đường A",
    }, citizen.userId, []);
    await expect(service.handle(citizen, sessionId, "Xác nhận", draft.action?.id, "confirm")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("starts a strictly labeled nonurgent draft without inventing optional fields", async () => {
    ollama.isConfigured.mockReturnValue(false);
    const draft = await service.handle(citizen, sessionId, "Tạo báo cáo; Loại báo cáo: ngập lụt, hạ tầng; Mô tả: QA không khẩn cấp; Tỉnh/thành phố: TP.HCM; Phường/xã: Bùi Đình Túy; Địa chỉ: 12 Đường A");
    expect(draft.action?.status).toBe("awaiting_confirmation");
    expect(draft.answer).toContain("QA không khẩn cấp");
    expect(draft.answer).toContain("ngập lụt, hạ tầng");
    expect(draft.answer).not.toContain("cần hỗ trợ khẩn cấp:");
    expect(draft.answer).toContain("GPS: chưa cung cấp");
    expect(ollama.understandAction).not.toHaveBeenCalled();
    expect(reports.createReport).not.toHaveBeenCalled();
  });

  it("retains a complete preview and ignores unrelated or negated followups while provider is down", async () => {
    ollama.understandAction.mockResolvedValue({ intent: "create_report", arguments: { category: ["flood"], description: "Ngập đường", province: "TP.HCM", ward: "Bùi Đình Túy", addressLine: "12 Đường A" } });
    const draft = await service.handle(citizen, sessionId, "Tạo báo cáo");
    ollama.isConfigured.mockReturnValue(false);
    for (const message of ["Thời tiết hôm nay ra sao?", "Đừng tạo báo cáo", "Xác nhận"]) {
      const result = await service.handle(citizen, sessionId, message);
      expect(result.action).toEqual(draft.action);
      expect(result.answer).toContain("12 Đường A");
      expect(reports.createReport).not.toHaveBeenCalled();
    }
  });

  it.each(["Xác nhận", "Đồng ý", "OK", "Cảm ơn", "Thời tiết hôm nay ra sao?", "Đừng tạo báo cáo"])("does not consume conversational text as a requested description: %s", async (reply) => {
    ollama.understandAction.mockResolvedValueOnce({ intent: "create_report", arguments: { category: ["flood"] } });
    const first = await service.handle(citizen, sessionId, "Tạo báo cáo");
    ollama.isConfigured.mockReturnValue(false);
    const result = await service.handle(citizen, sessionId, reply);
    expect(result.action).toEqual(first.action);
    const stored = JSON.parse(crypto.encrypt.mock.calls.at(-1)![0]);
    expect(stored.arguments).toEqual({ category: ["flood"] });
    expect(reports.createReport).not.toHaveBeenCalled();
  });

  it("does not confirm an incomplete draft and allows completion afterwards", async () => {
    ollama.understandAction.mockResolvedValue({ intent: "create_report", arguments: { category: ["flood"] } });
    const draft = await service.handle(citizen, sessionId, "Tạo báo cáo");
    const rejected = await service.handle(citizen, sessionId, "Xác nhận", draft.action?.id, "confirm");
    expect(rejected.action?.status).toBe("collecting");
    expect(rejected.answer).toContain("mô tả");
    expect(reports.createReport).not.toHaveBeenCalled();
    expect(await service.pendingAction(citizen, sessionId)).toMatchObject({ id: draft.action?.id, status: "collecting" });
    ollama.understandAction.mockResolvedValue(null);
    const ready = await service.handle(citizen, sessionId, "Mô tả: Ngập; Tỉnh/thành: TP.HCM; Phường/xã: Bùi Đình Túy; Địa chỉ: 12 Đường A");
    expect(ready.action?.status).toBe("awaiting_confirmation");
    expect((await service.handle(citizen, sessionId, "Xác nhận", ready.action?.id, "confirm")).action?.status).toBe("completed");
    expect(reports.createReport).toHaveBeenCalledTimes(1);
  });

  it.each(["Không tạo báo cáo", "Đừng tạo báo cáo", "Tôi không muốn tạo báo cáo", "Cách tạo báo cáo", "Tạo báo cáo như thế nào?", "Lũ quét là gì?", "Tôi đã tạo báo cáo hôm qua"])("does not start a report for %s even if extraction invents create intent", async (message) => {
    ollama.understandAction.mockResolvedValue({ intent: "create_report", arguments: {} });
    expect((await service.handle(citizen, sessionId, message)).handled).toBe(false);
    expect(values.size).toBe(0);
    expect(reports.createReport).not.toHaveBeenCalled();
  });

  it("rejects unsupported report categories and allows a correction", async () => {
    ollama.understandAction
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
    ollama.understandAction.mockResolvedValue({
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
    ollama.understandAction.mockResolvedValue({
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
    ollama.understandAction.mockResolvedValue({
      intent: "create_report",
      arguments: { category: "flood", description: "Ngập đường", province: "Đà Nẵng", ward: "Hải Châu", addressLine: "Đường A" },
    });
    const draft = await service.handle(citizen, sessionId, "Tạo báo cáo");
    await service.handle(citizen, sessionId, "Xác nhận", draft.action?.id, "confirm");
    await expect(service.handle(citizen, sessionId, "Xác nhận", draft.action?.id, "confirm")).rejects.toBeInstanceOf(BadRequestException);
    expect(reports.createReport).toHaveBeenCalledTimes(1);
  });

  it("exposes only the pending action ID and phase for an owned session", async () => {
    ollama.understandAction.mockResolvedValue({
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
    ollama.understandAction.mockResolvedValue({
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
    expect(ollama.understandAction).not.toHaveBeenCalled();
  });

  it("cancels a proposed write without calling the mutation service", async () => {
    ollama.understandAction.mockResolvedValue({
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
    ollama.understandAction.mockResolvedValue({
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
    ollama.understandAction.mockResolvedValue({
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
