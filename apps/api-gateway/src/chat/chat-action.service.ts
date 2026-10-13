import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AuthService } from "../auth/auth.service";
import { ReportsService } from "../reports/reports.service";
import { LoggerService, RedisService } from "vietflood-common";
import { ChatActionIntent, OllamaChatService } from "./ollama-chat.service";
import { ChatCryptoService, EncryptedMessage } from "./chat-crypto.service";

type ReportLocation = { latitude?: number; longitude?: number; clearLocation?: boolean };

type Actor = { userId: number; role: string; username: string };
type Pending = ChatActionIntent & { id: string; role: string };
type Result = {
  handled: boolean;
  answer?: string;
  action?: {
    id: string;
    status: "collecting" | "awaiting_confirmation" | "completed" | "cancelled";
    intent?: string;
  };
};

@Injectable()
export class ChatActionService {
  constructor(
    private readonly redis: RedisService,
    private readonly reports: ReportsService,
    private readonly auth: AuthService,
    private readonly ollama: OllamaChatService,
    private readonly logger: LoggerService,
    private readonly crypto: ChatCryptoService,
  ) {}

  async handle(
    actor: Actor,
    sessionId: string,
    message: string,
    actionId?: string,
    decision?: "confirm" | "cancel",
    location: ReportLocation = {},
    files: Express.Multer.File[] = [],
  ): Promise<Result> {
    const key = "chat:pending-action:" + actor.userId + ":" + sessionId;
    const pending = await this.load(key, actor.userId, sessionId);
    if (decision) {
      if (
        !actionId ||
        !pending ||
        pending.id !== actionId ||
        pending.role !== actor.role
      )
        throw new BadRequestException(
          "Pending action was not found or has expired",
        );
      if (files.length && pending.intent !== "create_report") {
        throw new BadRequestException("Evidence can only be attached to a new report");
      }
      if (decision === "cancel") {
        await this.redis.del(key);
        return {
          handled: true,
          answer: "Mình đã hủy thao tác. Dữ liệu của bạn chưa bị thay đổi.",
          action: { id: pending.id, status: "cancelled", intent: pending.intent },
        };
      }
      const lockKey = "chat:action-lock:" + pending.id;
      const lock = await this.redis
        .getClient()
        .set(lockKey, "1", "EX", 900, "NX");
      if (lock !== "OK")
        throw new ConflictException("Chat action has already been confirmed");
      const confirmed = this.withLocation(pending, location);
      const invalid = this.invalidReportFields(confirmed);
      if (invalid) {
        await this.redis.del(lockKey);
        return {
          handled: true,
          answer: invalid,
          action: { id: pending.id, status: "collecting", intent: pending.intent },
        };
      }
      let answer: string;
      try {
        answer = await this.execute(actor, confirmed, files);
      } catch (error) {
        await this.redis.del(lockKey);
        throw error;
      }
      await this.redis.del(key);
      return {
        handled: true,
        answer,
        action: { id: pending.id, status: "completed", intent: pending.intent },
      };
    }
    if (actionId)
      throw new BadRequestException("actionDecision is required with actionId");
    if (!this.ollama.isConfigured()) {
      if (pending)
        return {
          handled: true,
          answer:
            "Mình đang chờ thông tin để hoàn tất thao tác. Bạn có thể tiếp tục cung cấp thông tin cần thiết hoặc hủy thao tác.",
          action: { id: pending.id, status: "collecting", intent: pending.intent },
        };
      return { handled: false };
    }
    if (!pending && !this.mayBeAction(message)) return { handled: false };
    const parsed = await this.ollama.understandAction(
      message,
      actor.role,
      pending,
    );
    const intent = parsed?.intent ?? pending?.intent ?? "none";
    if (intent === "none") return { handled: false };
    const denied = this.roleError(actor.role, intent);
    if (denied) {
      await this.redis.del(key);
      return { handled: true, answer: denied };
    }
    const args = {
      ...(pending?.arguments ?? {}),
      ...(parsed?.arguments ?? {}),
    };
    const withLocation = intent === "create_report"
      ? this.withLocation({ id: pending?.id ?? "", role: actor.role, intent, arguments: args }, location).arguments
      : args;
    Object.assign(args, withLocation);
    if (intent === "get_user" && !this.positiveInteger(args.userId)) {
      return {
        handled: true,
        answer: this.ask(["userId"]),
        action: { id: pending?.id ?? randomUUID(), status: "collecting", intent },
      };
    }
    if (this.isRead(intent)) {
      if (pending) await this.redis.del(key);
      return { handled: true, answer: await this.read(actor, intent, args) };
    }
    const proposal: Pending = {
      id: pending?.id ?? randomUUID(),
      role: actor.role,
      intent,
      arguments: args,
    };
    const messageId = randomUUID();
    const encrypted = this.crypto.encrypt(
      JSON.stringify(proposal),
      actor.userId,
      sessionId,
      messageId,
      "assistant",
    );
    await this.redis.set(
      key,
      JSON.stringify({
        messageId,
        keyId: encrypted.keyId,
        nonce: encrypted.nonce.toString("base64"),
        ciphertext: encrypted.ciphertext.toString("base64"),
        authTag: encrypted.authTag.toString("base64"),
      }),
      900,
    );
    const missing = this.missing(intent, args);
    if (missing.length)
      return {
        handled: true,
        answer: this.ask(missing),
        action: { id: proposal.id, status: "collecting", intent },
      };
    const invalid = this.invalidReportFields(proposal);
    if (invalid)
      return {
        handled: true,
        answer: invalid,
        action: { id: proposal.id, status: "collecting", intent },
      };
    return {
      handled: true,
      answer: this.preview(proposal),
      action: { id: proposal.id, status: "awaiting_confirmation", intent },
    };
  }

  async pendingAction(
    actor: Actor,
    sessionId: string,
  ): Promise<Result["action"] | null> {
    const key = "chat:pending-action:" + actor.userId + ":" + sessionId;
    const pending = await this.load(key, actor.userId, sessionId);
    if (!pending || pending.role !== actor.role) return null;
    return {
      id: pending.id,
      intent: pending.intent,
      status: this.missing(pending.intent, pending.arguments).length || this.invalidReportFields(pending)
        ? "collecting"
        : "awaiting_confirmation",
    };
  }

  private mayBeAction(message: string): boolean {
    if (/cách|hướng dẫn|làm thế nào|how to|how do i/iu.test(message)) return false;
    if (
      /(?:hồ sơ của tôi|báo cáo của tôi|tài khoản của tôi|my profile|my reports)/iu.test(
        message,
      )
    )
      return true;
    const actionCue =
      /(?:tạo|lập|gửi|đăng|sửa|chỉnh|cập nhật|xóa|xoá|xem|tra cứu|liệt kê|danh sách|trạng thái|đổi trạng thái|update|delete|create|list|show|thay đổi)(?:\s|$)/iu;
    const appCue =
      /(?:báo cáo|hồ sơ|tài khoản|người dùng|report|profile|user)(?:\s|$)|#\s*\d+/iu;
    return actionCue.test(message) && appCue.test(message);
  }

  private async load(
    key: string,
    userId: number,
    sessionId: string,
  ): Promise<Pending | null> {
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch {
      this.logger.warn("Pending chat action lookup failed");
      throw new ServiceUnavailableException("Chat action is unavailable");
    }
    if (!raw) return null;
    let envelope: Record<string, string>;
    let encrypted: EncryptedMessage;
    try {
      envelope = JSON.parse(raw) as Record<string, string>;
      if (
        typeof envelope.messageId !== "string" ||
        typeof envelope.keyId !== "string" ||
        typeof envelope.nonce !== "string" ||
        typeof envelope.ciphertext !== "string" ||
        typeof envelope.authTag !== "string"
      )
        throw new Error();
      encrypted = {
        ciphertext: Buffer.from(envelope.ciphertext, "base64"),
        nonce: Buffer.from(envelope.nonce, "base64"),
        authTag: Buffer.from(envelope.authTag, "base64"),
        keyId: envelope.keyId,
      };
    } catch {
      await this.redis.del(key);
      return null;
    }
    const plaintext = this.crypto.decrypt(
      encrypted,
      userId,
      sessionId,
      envelope.messageId,
      "assistant",
    );
    try {
      const item: unknown = JSON.parse(plaintext);
      if (!item || typeof item !== "object") throw new Error();
      const value = item as Record<string, unknown>;
      if (
        typeof value.id !== "string" ||
        typeof value.role !== "string" ||
        typeof value.intent !== "string" ||
        !value.arguments ||
        typeof value.arguments !== "object"
      )
        throw new Error();
      return value as Pending;
    } catch {
      await this.redis.del(key);
      return null;
    }
  }

  private roleError(role: string, intent: string): string | null {
    const citizen = ["my_reports"];
    const staff = [
      "all_reports",
      "update_report_status",
      "all_users",
      "get_user",
      "update_user",
    ];
    if (citizen.includes(intent) && role !== "citizen")
      return "Chức năng này dành cho tài khoản công dân.";
    if (staff.includes(intent) && role !== "admin" && role !== "relief")
      return "Bạn không có quyền dùng chức năng này.";
    if (intent === "delete_user" && role !== "admin")
      return "Chỉ admin mới có quyền xóa tài khoản.";
    if (
      ["update_report", "delete_report"].includes(intent) &&
      !["citizen", "admin", "relief"].includes(role)
    )
      return "Bạn không có quyền dùng chức năng này.";
    return null;
  }

  private isRead(intent: string): boolean {
    return [
      "my_profile",
      "my_reports",
      "all_reports",
      "all_users",
      "get_user",
    ].includes(intent);
  }

  private missing(intent: string, args: Record<string, unknown>): string[] {
    const required: Record<string, string[]> = {
      update_my_profile: [],
      create_report: [
        "category",
        "description",
        "province",
        "ward",
        "addressLine",
      ],
      update_report: ["reportId"],
      delete_report: ["reportId"],
      update_report_status: ["reportId", "status"],
      get_user: ["userId"],
      update_user: ["userId"],
      delete_user: ["userId"],
    };
    const missing = (required[intent] ?? []).filter(
      (key) =>
        args[key] === undefined || args[key] === null ||
        (typeof args[key] === "string" && args[key].trim() === "") ||
        (key === "category" && (!Array.isArray(args[key]) || args[key].length === 0)),
    );
    const changeFields = [
      "phone",
      "province",
      "ward",
      "address_line",
      "category",
      "description",
      "addressLine",
      "severity",
      "isUrgent",
    ];
    if (
      ["update_my_profile", "update_report", "update_user"].includes(intent) &&
      !changeFields.some((key) => args[key] !== undefined)
    )
      missing.push("field");
    return missing;
  }

  private ask(fields: string[]): string {
    const labels: Record<string, string> = {
      id: "mã",
      category: "loại sự cố",
      description: "mô tả",
      province: "tỉnh/thành",
      ward: "phường/xã",
      addressLine: "địa chỉ",
      reportId: "mã báo cáo",
      status: "trạng thái mới",
      userId: "mã người dùng",
      field: "trường và giá trị muốn thay đổi",
    };
    const reportHelp = fields.some((field) =>
      ["category", "description", "province", "ward", "addressLine"].includes(field),
    )
      ? " Loại báo cáo gồm ngập lụt, sự cố, hạ tầng hoặc cứu hộ; có thể chọn nhiều loại. GPS và ảnh minh chứng là tùy chọn."
      : "";
    return (
      "Để tiếp tục, bạn cho mình biết " +
      fields.map((key) => labels[key] ?? key).join(", ") +
      " nhé." + reportHelp
    );
  }

  private withLocation(action: Pending, location: ReportLocation): Pending {
    const args = { ...action.arguments };
    if (location.clearLocation || args.clearLocation === true) {
      delete args.lat;
      delete args.lng;
      delete args.clearLocation;
    }
    if (location.latitude !== undefined) args.lat = location.latitude;
    if (location.longitude !== undefined) args.lng = location.longitude;
    if (action.intent === "create_report" && args.category !== undefined) {
      const categories = Array.isArray(args.category) ? args.category : [args.category];
      args.category = [...new Set(categories.map((value) => String(value).trim()).filter(Boolean))];
    }
    for (const key of ["description", "province", "ward", "addressLine"]) {
      if (typeof args[key] === "string") args[key] = (args[key] as string).trim();
    }
    return { ...action, arguments: args };
  }

  private invalidReportFields(action: Pending): string | null {
    if (action.intent !== "create_report") return null;
    const args = action.arguments;
    const categories = Array.isArray(args.category) ? args.category : [];
    const allowed = new Set(["flood", "incident", "infrastructure", "rescue"]);
    if (categories.some((value) => typeof value !== "string" || !allowed.has(value))) {
      return "Loại báo cáo chưa hợp lệ. Chọn một hoặc nhiều loại: ngập lụt, sự cố, hạ tầng, cứu hộ.";
    }
    for (const [key, label, max] of [
      ["description", "Mô tả", 5000],
      ["province", "Tỉnh/thành phố", 200],
      ["ward", "Phường/xã", 200],
      ["addressLine", "Địa chỉ", 500],
    ] as const) {
      const value = args[key];
      if (value !== undefined && (typeof value !== "string" || value.length > max)) {
        return `${label} chưa hợp lệ. Vui lòng gửi lại giá trị ngắn hơn.`;
      }
    }
    const hasLat = args.lat !== undefined && args.lat !== null;
    const hasLng = args.lng !== undefined && args.lng !== null;
    if (hasLat !== hasLng) return "Tọa độ GPS cần có cả vĩ độ và kinh độ. Bạn có thể gửi đủ hai giá trị hoặc bỏ qua GPS.";
    if (hasLat || hasLng) {
      const lat = Number(args.lat);
      const lng = Number(args.lng);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        return "Tọa độ GPS chưa hợp lệ. Vui lòng chia sẻ lại vị trí hoặc tiếp tục không có GPS.";
      }
      args.lat = lat;
      args.lng = lng;
    }
    return null;
  }

  private preview(action: Pending): string {
    const labels: Record<string, string> = {
      update_my_profile: "Cập nhật hồ sơ",
      create_report: "Tạo báo cáo",
      update_report: "Sửa báo cáo",
      delete_report: "Xóa báo cáo",
      update_report_status: "Đổi trạng thái báo cáo",
      update_user: "Sửa tài khoản",
      delete_user: "Xóa tài khoản",
    };
    const detail = Object.entries(action.arguments)
      .filter(([key]) => key !== "password" && key !== "evidences")
      .map(([key, value]) => `${this.actionFieldLabel(key)}: ${this.displayField(key, value)}`)
      .join("; ");
    const optionalReportDetails = action.intent === "create_report"
      ? ` GPS: ${action.arguments.lat !== undefined && action.arguments.lng !== undefined ? `${this.display(action.arguments.lat)}, ${this.display(action.arguments.lng)}` : "chưa cung cấp (tùy chọn)"}; ảnh minh chứng có thể đính kèm bên dưới (tùy chọn).`
      : "";
    return (
      "Bạn kiểm tra lại thông tin trước khi tiếp tục: " +
      (labels[action.intent] ?? action.intent) +
      (detail ? " — " + detail : "") + optionalReportDetails +
      ". Nếu thông tin đã đúng, bạn có thể xác nhận; nếu cần sửa, hãy gửi nội dung cần thay đổi hoặc hủy thao tác. Đề xuất hết hạn sau 15 phút."
    );
  }

  private actionFieldLabel(key: string): string {
    const labels: Record<string, string> = {
      id: "mã",
      reportId: "mã báo cáo",
      userId: "mã người dùng",
      category: "loại báo cáo",
      waterLevel: "mực nước",
      description: "mô tả",
      province: "tỉnh/thành",
      ward: "phường/xã",
      addressLine: "địa chỉ",
      address_line: "địa chỉ",
      lat: "vĩ độ",
      lng: "kinh độ",
      isUrgent: "cần hỗ trợ khẩn cấp",
      severity: "mức độ nghiêm trọng",
      status: "trạng thái",
      phone: "số điện thoại",
    };
    return labels[key] ?? key;
  }

  private displayField(key: string, value: unknown): string {
    if (key === "category") {
      const labels: Record<string, string> = {
        flood: "ngập lụt",
        incident: "sự cố",
        infrastructure: "hạ tầng",
        rescue: "cứu hộ",
      };
      const items = Array.isArray(value) ? value : [value];
      return items.map((item) => labels[String(item)] ?? this.display(item)).join(", ");
    }
    return this.display(value);
  }

  private async read(
    actor: Actor,
    intent: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    let value: unknown;
    if (intent === "my_profile")
      value = await this.auth.profile({
        userId: actor.userId,
        username: actor.username,
      });
    else if (intent === "my_reports")
      value = await this.reports.getAllReportsById(actor.userId);
    else if (intent === "all_reports")
      value = await this.reports.getAllReports();
    else if (intent === "all_users") value = await this.auth.getAllUsers();
    else if (intent === "get_user")
      value = await this.auth.getUserById(Number(args.userId));
    else return "Mình chưa thể tra cứu yêu cầu này.";
    this.assertResult(value);
    if (intent === "my_profile" || intent === "get_user")
      return this.userSummary(value);
    if (!Array.isArray(value))
      throw new ServiceUnavailableException("Requested data is unavailable");
    const rows =
      intent === "all_users"
        ? value.slice(0, 5).map((item) => this.userSummary(item))
        : value.slice(0, 5).map((item) => this.recordSummary(item));
    return rows.length
      ? rows.join("\n") + "\nHiển thị tối đa 5 kết quả."
      : "Chưa có dữ liệu phù hợp.";
  }

  private async execute(actor: Actor, action: Pending, files: Express.Multer.File[] = []): Promise<string> {
    const args = action.arguments;
    let result: unknown;
    switch (action.intent) {
      case "update_my_profile":
        result = await this.auth.updateProfile(
          actor.userId,
          this.pick(args, ["phone", "province", "ward", "address_line"]),
        );
        break;
      case "create_report": {
        const dto = this.pick(args, [
          "category",
          "waterLevel",
          "description",
          "province",
          "ward",
          "addressLine",
          "lat",
          "lng",
          "isUrgent",
          "severity",
        ]);
        dto.category = Array.isArray(dto.category)
          ? dto.category
          : [dto.category];
        result = await this.reports.createReport(dto as never, actor.userId, files);
        break;
      }
      case "update_report":
        result = await this.reports.updateReport(
          Number(args.reportId),
          await this.reportOwner(actor, Number(args.reportId)),
          this.pick(args, [
            "category",
            "waterLevel",
            "description",
            "province",
            "ward",
            "addressLine",
            "lat",
            "lng",
            "isUrgent",
            "severity",
          ]) as never,
        );
        break;
      case "delete_report":
        result = await this.reports.deleteReport(
          Number(args.reportId),
          await this.reportOwner(actor, Number(args.reportId)),
        );
        break;
      case "update_report_status":
        if (
          typeof args.status !== "string" ||
          !["pending", "verified", "resolved", "rejected"].includes(args.status)
        )
          throw new BadRequestException("Invalid report status");
        result = await this.reports.updateReportStatus(Number(args.reportId), {
          status: args.status,
        } as never);
        break;
      case "update_user":
        result = await this.auth.updateUserById(
          Number(args.userId),
          this.pick(args, ["phone", "province", "ward", "address_line"]),
        );
        break;
      case "delete_user":
        result = await this.auth.deleteUser(Number(args.userId));
        break;
      default:
        throw new BadRequestException("Unsupported chat action");
    }
    this.assertResult(result);
    const label: Record<string, string> = {
      update_my_profile: "Mình đã cập nhật hồ sơ",
      create_report: "Mình đã tạo báo cáo",
      update_report: "Mình đã cập nhật báo cáo",
      delete_report: "Mình đã xóa báo cáo",
      update_report_status: "Mình đã cập nhật trạng thái báo cáo",
      update_user: "Mình đã cập nhật tài khoản",
      delete_user: "Mình đã xóa tài khoản",
    };
    if (result && typeof result === "object") {
      const record = result as Record<string, unknown>;
      const details = ["id", "status"]
        .filter((key) => record[key] !== undefined)
        .map((key) => `${this.actionFieldLabel(key)}: ${this.display(record[key])}`)
        .join("; ");
      return `${label[action.intent] ?? "Thao tác đã hoàn tất"}${details ? ` (${details})` : ""}.`;
    }
    return `${label[action.intent] ?? "Thao tác đã hoàn tất"}.`;
  }

  private positiveInteger(value: unknown): boolean {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d+$/u.test(value)
          ? Number(value)
          : NaN;
    return Number.isSafeInteger(parsed) && parsed > 0;
  }

  private pick(
    source: Record<string, unknown>,
    keys: string[],
  ): Record<string, unknown> {
    return Object.fromEntries(
      keys
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, source[key]]),
    );
  }

  private async reportOwner(actor: Actor, reportId: number): Promise<number> {
    if (actor.role === "citizen") return actor.userId;
    const reports: unknown = await this.reports.getAllReports();
    this.assertResult(reports);
    if (!Array.isArray(reports))
      throw new ServiceUnavailableException("Report data is unavailable");
    const match = reports.find((item) => {
      if (!item || typeof item !== "object") return false;
      const wrapper = item as Record<string, unknown>;
      const report =
        wrapper.report && typeof wrapper.report === "object"
          ? (wrapper.report as Record<string, unknown>)
          : wrapper;
      return Number(report.id) === reportId;
    }) as Record<string, unknown> | undefined;
    const report =
      match?.report && typeof match.report === "object"
        ? (match.report as Record<string, unknown>)
        : match;
    if (!report || !Number.isInteger(report.userId))
      throw new NotFoundException("Report not found");
    return Number(report.userId);
  }

  private assertResult(value: unknown): void {
    if (value && typeof value === "object" && "error" in value)
      throw new ServiceUnavailableException(
        "Requested operation is unavailable",
      );
  }

  private display(value: unknown): string {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return String(value);
    return JSON.stringify(value) ?? "";
  }

  private userSummary(value: unknown): string {
    if (!value || typeof value !== "object")
      return "Không tìm thấy tài khoản phù hợp.";
    const record = value as Record<string, unknown>;
    const fields = [
      "id",
      "username",
      "role",
      "first_name",
      "middle_name",
      "last_name",
      "phone",
      "province",
      "ward",
      "address_line",
    ];
    return (
      fields
        .filter((key) => record[key] !== undefined)
        .map((key) => key + ": " + this.display(record[key]))
        .join("; ") || "Không tìm thấy tài khoản phù hợp."
    );
  }

  private recordSummary(value: unknown): string {
    if (!value || typeof value !== "object") return "";
    const wrapper = value as Record<string, unknown>;
    const record =
      wrapper.report && typeof wrapper.report === "object"
        ? (wrapper.report as Record<string, unknown>)
        : wrapper;
    const fields = [
      "id",
      "status",
      "category",
      "description",
      "province",
      "ward",
      "addressLine",
      "severity",
      "isUrgent",
    ];
    return fields
      .filter((key) => record[key] !== undefined)
      .map((key) => key + ": " + this.display(record[key]))
      .join("; ");
  }
}
