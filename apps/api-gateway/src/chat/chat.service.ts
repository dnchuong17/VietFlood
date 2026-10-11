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
import { GeminiChatService } from "./gemini-chat.service";
import { ChatActionService } from "./chat-action.service";

type ReportSummary = {
  id: number;
  status: string;
  severity?: number;
  isUrgent?: boolean;
};
type VerifiedFloodArea = {
  province: string;
  ward: string;
  reportCount: number;
  latestAt: string;
};
type ChatActor = { userId: number; role: string; username: string };

function isVerifiedFloodArea(value: unknown): value is VerifiedFloodArea {
  if (!value || typeof value !== "object") return false;
  const area = value as Record<string, unknown>;
  return (
    typeof area.province === "string" &&
    typeof area.ward === "string" &&
    Number.isInteger(area.reportCount) &&
    Number(area.reportCount) > 0 &&
    typeof area.latestAt === "string" &&
    !Number.isNaN(Date.parse(area.latestAt))
  );
}

const MAX_TURNS = 10;
const MAX_LOCAL_EXCERPT_LENGTH = 400;
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
    private readonly gemini: GeminiChatService,
    private readonly actions: ChatActionService,
  ) {
    this.logger.setServiceName(ChatService.name);
  }

  async reply(
    actorInput: ChatActor | number,
    input: ChatRequestDto,
    files: Express.Multer.File[] = [],
  ): Promise<{ answer: string; sessionId: string; action?: { id: string; status: string; intent?: string } }> {
    this.requireHistoryEnabled();
    const actor = typeof actorInput === "number"
      ? { userId: actorInput, role: "citizen", username: "" }
      : actorInput;
    const userId = actor.userId;
    const message = input.message.trim();
    if (!message) throw new BadRequestException("Message must not be empty");
    await this.checkRateLimit(userId);

    const sessionId = input.sessionId ?? randomUUID();
    if (input.sessionId) await this.ensureSession(userId, sessionId, false);
    const turns = input.sessionId
      ? await this.history.recent(userId, sessionId, MAX_TURNS)
      : [];

    const actionResult = await this.actions.handle(
      actor,
      sessionId,
      message,
      input.actionId,
      input.actionDecision,
      { latitude: input.latitude, longitude: input.longitude, clearLocation: input.clearLocation },
      files,
    );
    let answer: string;
    let kind: ChatKind;
    let action: { id: string; status: string; intent?: string } | undefined;
    if (actionResult.handled) {
      answer = actionResult.answer ?? "Mình chưa xử lý được thao tác này.";
      kind = "action";
      action = actionResult.action;
    } else if (this.isStatusQuestion(message, turns)) {
      answer = await this.reportStatus(userId, message);
      kind = "report_status";
    } else if (this.isReportGuideQuestion(message)) {
      answer = this.reportGuide();
      kind = "report_guide";
    } else if (this.isFloodLocationQuestion(message)) {
      answer = await this.floodLocationReply();
      kind = "community_reports";
    } else if (this.isReportCountQuestion(message)) {
      answer = await this.reportCountReply(message);
      kind = "community_reports";
    } else {
      const smallTalk = smallTalkReply(message);
      if (smallTalk) {
        answer = smallTalk;
        kind = "small_talk";
      } else {
        const result = await this.knowledgeAnswer(userId, sessionId, message);
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
    return { answer, sessionId, ...(action ? { action } : {}) };
  }

  async listSessions(userId: number, limit = 20, cursor?: string) {
    this.requireHistoryEnabled();
    return this.history.list(userId, limit, cursor);
  }

  async listMessages(
    actorInput: ChatActor | number,
    sessionId: string,
    limit = 20,
    cursor?: string,
  ) {
    this.requireHistoryEnabled();
    const actor = typeof actorInput === "number"
      ? { userId: actorInput, role: "citizen", username: "" }
      : actorInput;
    const userId = actor.userId;
    await this.ensureSession(userId, sessionId, true);
    const result = await this.history.messages(userId, sessionId, limit, cursor);
    if (!result) throw new NotFoundException("Chat session not found");
    return {
      ...result,
      pendingAction: await this.actions.pendingAction(actor, sessionId),
    };
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

  private async knowledgeAnswer(
    userId: number,
    sessionId: string,
    message: string,
  ): Promise<{ answer: string; kind: ChatKind }> {
    const reviewedFirstAid = firstAidFallback(message);
    if (reviewedFirstAid) return { answer: reviewedFirstAid, kind: "first_aid" };

    const isFollowUp = this.isFollowUpQuestion(message);
    const priorAnswers = isFollowUp
      ? await this.history.recentKnowledgeAnswers(userId, sessionId, 2)
      : [];
    const priorQuestions = isFollowUp
      ? await this.history.recentKnowledgeQuestions(userId, sessionId, 2)
      : [];
    if (isFollowUp && priorAnswers.length === 0) {
      return {
        answer: "Mình chưa rõ bạn đang hỏi tiếp về chủ đề nào. Bạn muốn hỏi về an toàn lũ, sơ cứu hay báo cáo VietFlood?",
        kind: "fallback",
      };
    }

    // Resolve short follow-ups against the topic they refer to. Prior user text
    // is used only to retrieve passages; only assistant answers enter Gemini context.
    const retrievalQuery = [...priorQuestions.map((turn) => turn.content), message].join(" ");
    const previousAnswers = priorAnswers.map((turn) => turn.content);
    const passages = await this.knowledge.search(retrievalQuery, previousAnswers);

    let generated: string | null = null;
    const geminiConfig = this.gemini.configurationStatus?.() ??
      (this.gemini.isConfigured() ? "ready" : "configuration_unavailable");
    if (geminiConfig === "ready") {
      try {
        const approvedPassages = await this.knowledge.searchApproved(retrievalQuery, previousAnswers);
        this.logger.info("Chat approved knowledge retrieval completed", {
          passageCount: approvedPassages.length,
        });
        if (approvedPassages.length > 0) {
          const knowledgeContext = priorAnswers.map((turn) => ({
            role: "assistant" as const,
            content: turn.content,
          }));
          generated = await this.gemini.answer(message, approvedPassages, knowledgeContext);
        } else {
          this.logger.warn("Gemini generation skipped", { reason: "no_approved_passages" });
        }
      } catch {
        this.logger.warn("Approved knowledge lookup failed", { fallback: "local_excerpts_or_no_information" });
      }
    } else {
      this.logger.warn("Gemini generation unavailable", { reason: geminiConfig });
    }
    const excerpts = [...new Set(passages
      .map((passage) => passage
        .replace(/https?:\/\/\S+/giu, "")
        .replace(/<[^>]+>/gu, "")
        .replace(/\[[^\]]+\]\([^)]*\)/gu, "")
        .replace(/[#*`_]/gu, "")
        .replace(/\s+/gu, " ")
        .trim())
      .filter(Boolean))]
      .slice(0, 3)
      .map((passage) => this.truncateLocalExcerpt(passage));
    const excerpt = excerpts.length > 1
      ? excerpts.map((passage) => `• ${passage}`).join("\n")
      : excerpts[0] ?? "";
    const urgent = /đang (kẹt|ngập|bị cuốn)|cứu tôi|cấp cứu|khẩn cấp/iu.test(message);
    if (generated) {
      return {
        answer: `${urgent ? "Trước hết, hãy tới nơi an toàn và gọi cứu hộ hoặc cấp cứu ngay. " : ""}${generated}`,
        kind: "knowledge",
      };
    }
    if (!excerpt) {
      this.logger.warn("Chat knowledge fallback selected", {
        reason: "no_local_passages",
        followUp: isFollowUp,
      });
      if (isFollowUp) {
        return {
          answer: "Mình chưa tìm thấy thông tin bổ sung khác trong tài liệu hiện có. Bạn muốn mình tìm kỹ hơn về phần nào?",
          kind: "fallback",
        };
      }
      return { answer: this.outOfScopeReply(message), kind: "fallback" };
    }
    this.logger.warn("Chat knowledge fallback selected", {
      reason: "gemini_unavailable_or_failed",
      localExcerptCount: excerpts.length,
    });
    return {
      answer: `${urgent ? "Trước hết, hãy tới nơi an toàn và gọi cứu hộ hoặc cấp cứu ngay. " : ""}Thông tin liên quan mình tìm thấy:\n${excerpt}`,
      kind: "knowledge",
    };
  }

  private truncateLocalExcerpt(passage: string): string {
    if (passage.length <= MAX_LOCAL_EXCERPT_LENGTH) return passage;
    const excerpt = passage.slice(0, MAX_LOCAL_EXCERPT_LENGTH);
    const sentenceEnds = [...excerpt.matchAll(/[.!?](?=\s|$)/gu)];
    const sentenceEnd = sentenceEnds[sentenceEnds.length - 1]?.index;
    if (sentenceEnd !== undefined) return excerpt.slice(0, sentenceEnd + 1).trim();

    const wordEnd = excerpt.lastIndexOf(" ");
    if (wordEnd > 0) return `${excerpt.slice(0, wordEnd).trimEnd()}…`;
    return `${Array.from(excerpt).slice(0, MAX_LOCAL_EXCERPT_LENGTH - 1).join("")}…`;
  }

  private isFollowUpQuestion(message: string): boolean {
    const text = message.trim().toLocaleLowerCase("vi");
    return /^(?:vậy còn|thế còn|còn về|còn|vậy|thế|và|nếu vậy|trong trường hợp đó|trường hợp đó|điều đó|cái đó|như vậy|như thế|nó|how about|what about|and then|in that case|what if)(?:\s|$|[?!,.])/iu.test(text) ||
      /^(?:bao lâu|ở đâu|khi nào|thế nào|làm sao|có an toàn không|có được không|cần bao nhiêu|how long|where|when|how about it|is it safe|what should i do)\??[!. ]*$/iu.test(text) ||
      /\b(?:điều này|việc đó|chuyện đó|nội dung trên|that|those|it|they)\b/iu.test(text);
  }

  private outOfScopeReply(message: string): string {
    const urgent = /đang (kẹt|ngập|bị cuốn)|cứu tôi|cấp cứu|khẩn cấp/iu.test(message);
    return `${urgent ? "Nếu bạn đang gặp nguy hiểm, hãy tới nơi an toàn và gọi lực lượng cứu hộ hoặc cấp cứu địa phương ngay. " : ""}Mình có thể hỗ trợ về an toàn lũ, sơ cứu cơ bản và báo cáo VietFlood. Bạn muốn tìm hiểu nội dung nào?`;
  }

  private isFloodLocationQuestion(message: string): boolean {
    const text = message.trim().toLocaleLowerCase("vi");
    if (/thường|hay xảy ra|mùa lũ|hằng năm|lịch sử/u.test(text)) return false;
    return /^(?:(?:hiện(?:nay|tại)|bây giờ|hôm nay)\s+)?(?:lũ(?:\s+lụt)?|ngập)(?:\s+đang)?\s+(?:ở đâu|khu vực nào|chỗ nào)\??[!. ]*$/u.test(text) ||
      /^(?:(?:hiện(?:nay|tại)|bây giờ|hôm nay)\s+)?(?:điểm ngập|khu vực ngập|vị trí ngập)(?:\s+(?:ở đâu|hiện nay|hiện tại))?\??[!. ]*$/u.test(text);
  }

  private isReportCountQuestion(message: string): boolean {
    return /báo cáo|report/iu.test(message) &&
      /bao nhiêu|số lượng|thống kê|tổng số|tổng cộng|đếm|có .* báo cáo/iu.test(message);
  }

  private reportCategoryFromQuestion(message: string): string | undefined {
    if (/ngập|lũ|lụt/iu.test(message)) return "flood";
    if (/cứu hộ|cứu nạn|rescue/iu.test(message)) return "rescue";
    if (/hạ tầng|công trình|infrastructure/iu.test(message)) return "infrastructure";
    if (/sự cố|tai nạn|incident/iu.test(message)) return "incident";
    return undefined;
  }

  private async reportCountReply(message: string): Promise<string> {
    let count: unknown;
    try {
      count = await this.reports.getRecentVerifiedReportCount(
        this.reportCategoryFromQuestion(message),
      );
    } catch (error) {
      const reason = error instanceof Error ? `${error.name} ${error.message}` : "";
      this.logger.warn(/timeout|timed out|etimedout/iu.test(reason)
        ? "Recent verified report count RPC timed out"
        : "Recent verified report count RPC failed");
      throw new ServiceUnavailableException("Recent verified reports are unavailable");
    }
    if (!Number.isSafeInteger(count) || Number(count) < 0) {
      this.logger.warn("Recent verified report count response was invalid");
      throw new ServiceUnavailableException("Recent verified reports are unavailable");
    }

    const category = this.reportCategoryFromQuestion(message);
    const categoryLabel = category ? ` ${this.reportCategoryLabel(category)}` : "";
    if (count === 0) {
      return `Trong 24 giờ qua, chưa có báo cáo${categoryLabel} nào được xác minh trên VietFlood. Điều đó không khẳng định là không có sự cố; bạn nên theo dõi thông báo từ cơ quan chức năng địa phương.`;
    }
    return `Trong 24 giờ qua, VietFlood đã ghi nhận ${count} báo cáo${categoryLabel} được xác minh. Đây là thông tin do cộng đồng gửi, không phải cảnh báo thời gian thực. Bạn hãy tiếp tục theo dõi thông báo từ cơ quan chức năng địa phương.`;
  }

  private reportCategoryLabel(category: string): string {
    const labels: Record<string, string> = {
      flood: "lũ/ngập",
      incident: "sự cố",
      infrastructure: "hạ tầng",
      rescue: "cứu hộ",
    };
    return labels[category] ?? "";
  }

  private async floodLocationReply(): Promise<string> {
    let areas: unknown;
    try {
      areas = await this.reports.getRecentVerifiedFloodAreas();
    } catch (error) {
      const reason = error instanceof Error ? `${error.name} ${error.message}` : "";
      this.logger.warn(/timeout|timed out|etimedout/iu.test(reason)
        ? "Recent flood report RPC timed out"
        : "Recent flood report RPC failed");
      throw new ServiceUnavailableException("Recent flood reports are unavailable");
    }

    if (!Array.isArray(areas)) {
      this.logger.warn("Recent flood report response was invalid");
      throw new ServiceUnavailableException("Recent flood reports are unavailable");
    }
    const validAreas = areas.filter(isVerifiedFloodArea);
    if (validAreas.length !== areas.length) {
      this.logger.warn("Recent flood report response was invalid");
      throw new ServiceUnavailableException("Recent flood reports are unavailable");
    }

    if (validAreas.length === 0) {
      return "Trong 24 giờ qua, chưa có báo cáo lũ nào được xác minh trên VietFlood. Điều đó không khẳng định là không có lũ; bạn hãy kiểm tra cảnh báo từ cơ quan chức năng địa phương.";
    }

    const locations = validAreas.slice(0, 5).map((area) => {
      const latestAt = new Date(area.latestAt).toLocaleString("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
        dateStyle: "short",
        timeStyle: "short",
      });
      return `${area.ward}, ${area.province} (${area.reportCount} báo cáo; gần nhất ${latestAt})`;
    });
    return `Trong 24 giờ qua, các báo cáo lũ đã xác minh trên VietFlood ghi nhận tại: ${locations.join("; ")}. Đây là thông tin cộng đồng, không phải cảnh báo thời gian thực; bạn hãy theo dõi thông báo từ cơ quan chức năng địa phương.`;
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
    return "Bạn có thể tạo báo cáo trong biểu mẫu VietFlood. Hãy điền mô tả, tỉnh/thành, phường/xã, địa chỉ và loại sự cố; thêm vị trí nếu biết. Có thể đính kèm tối đa 10 ảnh hoặc video. Chọn mức độ nghiêm trọng phù hợp và đánh dấu khẩn cấp nếu cần trợ giúp gấp. Sau khi gửi, bạn có thể theo dõi trạng thái trong danh sách báo cáo: pending là chờ xử lý, verified là đã xác minh, resolved là đã giải quyết, còn rejected là bị từ chối. Nếu đang gặp nguy hiểm, hãy tới nơi an toàn và gọi cứu hộ.";
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
        : `Mình không tìm thấy báo cáo #${requestedId} trong danh sách của bạn.`;
    }

    if (reports.length === 0) return "Bạn chưa gửi báo cáo nào.";
    return (
      "Đây là trạng thái các báo cáo gần đây của bạn: " +
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
