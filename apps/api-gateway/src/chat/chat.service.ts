import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { LoggerService, RedisService } from "vietflood-common";

import { ReportsService } from "../reports/reports.service";
import { ChatRequestDto } from "./dto/chat.dto";
import { ChatHistoryRepository, ChatKind, ChatTurn } from "./chat-history.repository";
import { firstAidFallback } from "./first-aid-guidance";
import { smallTalkReply } from "./small-talk";
import { QdrantKnowledgeService } from "./qdrant-knowledge.service";

type ReportSummary = {
  id: number;
  status: string;
  severity?: number;
  isUrgent?: boolean;
};

const MAX_TURNS = 10;
const REQUESTS_PER_MINUTE = 20;
const REPORT_STATUS_LABELS: Record<string, string> = {
  pending: "chờ xử lý",
  verified: "đã xác minh",
  resolved: "đã giải quyết",
  rejected: "bị từ chối",
};

@Injectable()
export class ChatService {
  constructor(
    private readonly redis: RedisService,
    private readonly reports: ReportsService,
    private readonly knowledge: QdrantKnowledgeService,
    private readonly history: ChatHistoryRepository,
    private readonly logger: LoggerService,
  ) {
    this.logger.setServiceName(ChatService.name);
  }

  async reply(
    userId: number,
    input: ChatRequestDto,
  ): Promise<{ answer: string; sessionId: string }> {
    this.requireHistoryEnabled();
    const message = input.message.trim();
    if (!message) throw new BadRequestException("Message must not be empty");
    await this.checkRateLimit(userId);

    const sessionId = input.sessionId ?? randomUUID();
    if (input.sessionId) await this.ensureSession(userId, sessionId, false);
    const turns = input.sessionId
      ? await this.history.recent(userId, sessionId, MAX_TURNS)
      : [];

    let answer: string;
    let kind: ChatKind;
    if (this.isStatusQuestion(message, turns)) {
      answer = await this.reportStatus(userId, message);
      kind = "report_status";
    } else if (this.isReportGuideQuestion(message)) {
      answer = this.reportGuide();
      kind = "report_guide";
    } else {
      const smallTalk = smallTalkReply(message);
      if (smallTalk) {
        answer = smallTalk;
        kind = "small_talk";
      } else {
        const result = await this.knowledgeAnswer(message);
        answer = result.answer;
        kind = result.kind;
      }
    }

    if (input.sessionId) {
      if (!(await this.history.append(userId, sessionId, message, answer, kind)))
        throw new NotFoundException("Chat session not found");
    } else {
      await this.history.create(userId, sessionId, message, answer, kind);
    }
    return { answer, sessionId };
  }

  async listSessions(userId: number, limit = 20, cursor?: string) {
    this.requireHistoryEnabled();
    return this.history.list(userId, limit, cursor);
  }

  async listMessages(userId: number, sessionId: string, limit = 20, cursor?: string) {
    this.requireHistoryEnabled();
    await this.ensureSession(userId, sessionId, true);
    const result = await this.history.messages(userId, sessionId, limit, cursor);
    if (!result) throw new NotFoundException("Chat session not found");
    return result;
  }

  async deleteSession(userId: number, sessionId: string): Promise<void> {
    this.requireHistoryEnabled();
    const access = await this.history.access(userId, sessionId);
    if (access === "other") throw new NotFoundException("Chat session not found");
    if (access === "missing") {
      const owner = await this.legacyOwner(sessionId);
      if (owner !== String(userId)) throw new NotFoundException("Chat session not found");
    }
    const deleted = await this.history.delete(userId, sessionId, async (existsInDatabase) => {
      if (!existsInDatabase && (await this.legacyOwner(sessionId)) !== String(userId))
        return false;
      try {
        await this.redis.del(`chat:session:${userId}:${sessionId}`);
        await this.redis.del(`chat:owner:${sessionId}`);
      } catch {
        this.logger.warn("Legacy chat session deletion failed");
        throw new ServiceUnavailableException("Chat session is unavailable");
      }
      return !existsInDatabase;
    });
    if (!deleted) throw new NotFoundException("Chat session not found");
  }

  private requireHistoryEnabled(): void {
    if (process.env.CHAT_HISTORY_ENABLED === "false")
      throw new ServiceUnavailableException("Chat history is unavailable");
  }

  private async knowledgeAnswer(message: string): Promise<{ answer: string; kind: ChatKind }> {
    const reviewedFirstAid = firstAidFallback(message);
    if (reviewedFirstAid) return { answer: reviewedFirstAid, kind: "first_aid" };
    const passages = await this.knowledge.search(message);

    if (passages.length === 0) {
      return {
        answer: this.outOfScopeReply(message),
        kind: "fallback",
      };
    }
    // Staging passages stay inside VietFlood. They must not be sent to Gemini.
    const excerpt = passages[0]
      .replace(/https?:\/\/\S+/giu, "")
      .replace(/<[^>]+>/gu, "")
      .replace(/\[[^\]]+\]\([^)]*\)/gu, "")
      .replace(/[#*`_]/gu, "")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 900);
    if (!excerpt) {
      return { answer: this.outOfScopeReply(message), kind: "fallback" };
    }
    const urgent = /đang (kẹt|ngập|bị cuốn)|cứu tôi|cấp cứu|khẩn cấp/iu.test(message);
    return {
      answer: `${urgent ? "Hãy tới nơi an toàn và gọi cứu hộ/cấp cứu ngay. " : ""}Theo kho kiến thức VietFlood: ${excerpt}`,
      kind: "knowledge",
    };
  }

  private outOfScopeReply(message: string): string {
    const urgent = /đang (kẹt|ngập|bị cuốn)|cứu tôi|cấp cứu|khẩn cấp/iu.test(message);
    return `${urgent ? "Nếu bạn đang gặp nguy hiểm, hãy tới nơi an toàn và gọi lực lượng cứu hộ/cấp cứu địa phương ngay. " : ""}Mình là trợ lý VietFlood, tập trung vào an toàn lũ, sơ cứu cơ bản và báo cáo trên VietFlood. Bạn có thể hỏi như “Cần chuẩn bị gì trước lũ?” hoặc “Trạng thái báo cáo của tôi thế nào?”.`;
  }

  private isStatusQuestion(message: string, turns: ChatTurn[]): boolean {
    const report = /báo cáo|đơn (của tôi|đã gửi)|report/iu.test(message);
    const status =
      /trạng thái|tình trạng|tiến độ|status|đã (xử lý|duyệt|giải quyết)|của tôi|#\s*\d+/iu.test(
        message,
      );
    const lastTurn = turns[turns.length - 1];
    const followup =
      lastTurn?.role === "assistant" &&
      /trạng thái báo cáo/iu.test(lastTurn.content) &&
      /(?:#|số|mã)\s*\d+/iu.test(message);
    return (report && status) || Boolean(followup);
  }

  private isReportGuideQuestion(message: string): boolean {
    return /(tạo|gửi|đăng|nộp|create|submit).*(báo cáo|report)|upload|tải (ảnh|tệp)|bằng chứng|mức độ nghiêm trọng|khẩn cấp.*báo cáo|severity|urgency/iu.test(
      message,
    );
  }

  private reportGuide(): string {
    return "Để tạo báo cáo, đăng nhập và dùng biểu mẫu báo cáo của VietFlood. Cung cấp mô tả, tỉnh, phường/xã, địa chỉ và loại sự cố; thêm vị trí nếu có. Bạn có thể tải tối đa 10 tệp ảnh/video làm bằng chứng. Đánh dấu khẩn cấp khi cần hỗ trợ gấp và chọn mức độ nghiêm trọng phù hợp với tình hình thực tế. Sau khi gửi, dùng danh sách báo cáo của bạn để theo dõi trạng thái: pending (chờ xử lý), verified (đã xác minh), resolved (đã giải quyết) hoặc rejected (bị từ chối). Nếu đang gặp nguy hiểm, hãy tìm nơi an toàn và gọi cứu hộ ngay.";
  }

  private async reportStatus(userId: number, message: string): Promise<string> {
    let result: unknown;
    try {
      result = await this.reports.getAllReportsById(userId);
    } catch {
      this.logger.warn("Report status request failed");
      throw new ServiceUnavailableException("Report status is unavailable");
    }
    if (!Array.isArray(result))
      throw new ServiceUnavailableException("Report status is unavailable");

    const reports = (result as unknown[]).filter(
      (item): item is ReportSummary => {
        if (item === null || typeof item !== "object") return false;
        const record = item as Record<string, unknown>;
        return (
          typeof record.id === "number" && typeof record.status === "string"
        );
      },
    );
    const requestedId = message.match(
      /(?:#|mã\s*|số\s*|báo cáo\s*|report\s*)(\d+)/iu,
    )?.[1];
    if (requestedId) {
      const report = reports.find((item) => item.id === Number(requestedId));
      return report
        ? `Báo cáo #${report.id} của bạn hiện có trạng thái: ${REPORT_STATUS_LABELS[report.status] ?? report.status}.`
        : `Tôi không tìm thấy báo cáo #${requestedId} trong tài khoản của bạn.`;
    }

    if (reports.length === 0) return "Tài khoản của bạn chưa có báo cáo nào.";
    return (
      "Trạng thái báo cáo gần đây của bạn: " +
      reports
        .slice(0, 5)
        .map(
          (report) =>
            `#${report.id}: ${REPORT_STATUS_LABELS[report.status] ?? report.status}`,
        )
        .join("; ") +
      "."
    );
  }

  private async checkRateLimit(userId: number): Promise<void> {
    const minute = Math.floor(Date.now() / 60_000);
    const key = `chat:rate:${userId}:${minute}`;
    try {
      const result = await this.redis
        .getClient()
        .multi()
        .incr(key)
        .expire(key, 120)
        .exec();
      const count = result?.[0]?.[1];
      if (typeof count !== "number")
        throw new Error("Invalid rate-limit result");
      if (count > REQUESTS_PER_MINUTE) {
        throw new HttpException(
          "Chat request limit exceeded; try again in a minute",
          429,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.warn("Chat rate-limit storage unavailable");
      throw new ServiceUnavailableException("Chat session is unavailable");
    }
  }

  private async legacyOwner(sessionId: string): Promise<string | null> {
    try {
      return await this.redis.get(`chat:owner:${sessionId}`);
    } catch {
      this.logger.warn("Legacy chat session read failed");
      throw new ServiceUnavailableException("Chat session is unavailable");
    }
  }

  private async ensureSession(userId: number, sessionId: string, hideForeign: boolean): Promise<void> {
    const access = await this.history.access(userId, sessionId);
    if (access === "owned") return;
    if (access === "other")
      throw hideForeign
        ? new NotFoundException("Chat session not found")
        : new ForbiddenException("Chat session belongs to another user");
    const owner = await this.legacyOwner(sessionId);
    if (owner !== String(userId)) {
      if (owner && !hideForeign)
        throw new ForbiddenException("Chat session belongs to another user");
      throw new NotFoundException("Chat session not found or expired");
    }
    let turns: ChatTurn[];
    try {
      const raw = await this.redis.get(`chat:session:${userId}:${sessionId}`);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(parsed) || parsed.length > MAX_TURNS ||
        !parsed.every((item) => item && typeof item === "object" &&
          (item.role === "user" || item.role === "assistant") &&
          typeof item.content === "string" && item.content.length <= 10000))
        throw new Error("Invalid legacy session");
      turns = parsed.map((item) => ({ role: item.role, content: item.content, kind: "legacy" }));
    } catch {
      this.logger.warn("Legacy chat session import failed");
      throw new ServiceUnavailableException("Chat session is unavailable");
    }
    await this.history.importLegacy(userId, sessionId, turns,
      async () => (await this.legacyOwner(sessionId)) === String(userId));
    try {
      await this.redis.del(`chat:session:${userId}:${sessionId}`);
      await this.redis.del(`chat:owner:${sessionId}`);
    } catch {
      this.logger.warn("Legacy chat session cleanup failed");
    }
  }
}
