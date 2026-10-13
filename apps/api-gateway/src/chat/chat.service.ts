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
import { QdrantKnowledgeService } from "./qdrant-knowledge.service";
import { OllamaChatService } from "./ollama-chat.service";
import { ChatActionService } from "./chat-action.service";
import { RagAnswerService } from "./rag-answer.service";
import { RagDetails } from "./rag.types";

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
const REQUESTS_PER_MINUTE = 20;


@Injectable()
export class ChatService {
  constructor(
    private readonly redis: RedisService,
    private readonly reports: ReportsService,
    private readonly knowledge: QdrantKnowledgeService,
    private readonly history: ChatHistoryRepository,
    private readonly logger: LoggerService,
    private readonly ollama: OllamaChatService,
    private readonly actions: ChatActionService,
    private readonly rag: RagAnswerService,
  ) {
    this.logger.setServiceName(ChatService.name);
  }

  async reply(
    actorInput: ChatActor | number,
    input: ChatRequestDto,
    files: Express.Multer.File[] = [],
  ): Promise<{ answer: string; sessionId: string; action?: { id: string; status: string; intent?: string } } & Partial<RagDetails>> {
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
    let details: RagDetails | undefined;
    let action: { id: string; status: string; intent?: string } | undefined;
    if (actionResult.handled) {
      answer = actionResult.answer ?? "Thao tác chưa hoàn tất.";
      kind = "action";
      action = actionResult.action;
    } else {
      const [questions, answers] = input.sessionId ? await Promise.all([
        this.history.recentKnowledgeQuestions(userId, sessionId, 2),
        this.history.recentKnowledgeAnswers(userId, sessionId, 2),
      ]) : [[], []];
      const knowledgeTurns = questions.flatMap((q, index) => answers[index] ? [q, answers[index]] : [q]);
      const result = await this.rag.reply(message, knowledgeTurns.map(t => ({ role:t.role, content:t.content })));
      ({ answer, ...details } = result);
      kind = result.generationMode === "introduction" ? "small_talk" : result.generationMode === "grounded_synthesis" ? "knowledge" : "fallback";
    }
    const storedAnswer = details ? JSON.stringify({ _vietfloodRag: 1, answer, details }) : answer;
    if (input.sessionId) {
      if (!(await this.history.append(userId, sessionId, message, storedAnswer, kind)))
        throw new NotFoundException("Chat session not found");
    } else {
      await this.history.create(userId, sessionId, message, storedAnswer, kind);
    }
    return { answer, sessionId, ...details, ...(action ? { action } : {}) };
  }

  async source(documentId: string, version: number) { return this.knowledge.source(documentId, version); }

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
