import { Injectable, OnModuleInit, ServiceUnavailableException } from "@nestjs/common";
import { LoggerService } from "vietflood-common";
import { Passage } from "./rag.types";
import { requestId } from "./chat-trace";

@Injectable()
export class QdrantKnowledgeService implements OnModuleInit {
  constructor(private readonly logger: LoggerService) { this.logger.setServiceName(QdrantKnowledgeService.name); }
  async onModuleInit() {
    try { this.logger.info("RAG startup ready", { ...(await this.request<Record<string, unknown>>("/health/ready")), requestId: requestId() }); }
    catch { this.logger.warn("RAG startup unavailable; knowledge requests will return unavailable", { requestId: requestId() }); }
  }
  async retrieve(queries: string[], candidateLimit: number, limit: number, signal?: AbortSignal): Promise<Passage[]> {
    const result = await this.request<{ passages: Passage[] }>("/search", { queries, candidateLimit, limit, requestId: requestId() }, signal);
    if (!Array.isArray(result.passages) || result.passages.some(p => !p || typeof p.id !== "string" || typeof p.text !== "string" || typeof p.documentId !== "string" || !Number.isInteger(p.version) || typeof p.title !== "string" || !Array.isArray(p.sectionPath))) throw new ServiceUnavailableException("Invalid retrieval response");
    this.logger.info("RAG evidence retrieved", { requestId: requestId(), passageCount: result.passages.length, evidenceIds: result.passages.map(p => p.id).join(",") });
    return result.passages;
  }
  async source(documentId: string, version: number) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(documentId) || !Number.isSafeInteger(version) || version < 1) throw new ServiceUnavailableException("Invalid source reference");
    return this.request<{ documentId: string; version: number; title: string; text: string; sourceUrl: string }>(`/documents/${encodeURIComponent(documentId)}/${version}`);
  }
  private async request<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
    const url = process.env.RAG_SERVICE_URL?.replace(/\/$/, "");
    const token = process.env.RAG_SERVICE_TOKEN;
    if (!url || !token) {
      this.logger.warn("RAG configuration missing", { requestId: requestId(), reason: !url ? "missing_service_url" : "missing_service_token" });
      throw new ServiceUnavailableException("Retrieval is not configured");
    }
    try {
      const response = await fetch(url + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "X-Rag-Token": token }, body: body ? JSON.stringify(body) : undefined, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000) });
      if (!response.ok) {
        this.logger.warn("RAG service HTTP failure", { requestId: requestId(), status: response.status, endpoint: path.startsWith("/documents/") ? "source" : path });
        throw new ServiceUnavailableException("Retrieval unavailable");
      }
      return await response.json() as T;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.warn("RAG service connection failure", { requestId: requestId(), errorType: error instanceof Error ? error.name : "unknown" });
      throw new ServiceUnavailableException("Retrieval unavailable");
    }
  }
}
