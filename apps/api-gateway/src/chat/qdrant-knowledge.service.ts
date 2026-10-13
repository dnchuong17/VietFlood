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
    const uniqueQueries = [...new Set(queries)];
    if (!uniqueQueries.length) return [];
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new DOMException("Retrieval timed out", "TimeoutError")), this.searchTimeout());
    const retrievalSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const buckets: Passage[][] = [];
    try {
      // The Python service reranks queries × candidates. Query separately using a
      // shared candidate budget to avoid multiplying CPU work across subqueries.
      const budget = Math.max(candidateLimit, uniqueQueries.length);
      for (let index = 0; index < uniqueQueries.length; index++) {
        retrievalSignal.throwIfAborted();
        const perQueryBudget = Math.floor(budget / uniqueQueries.length) + (index < budget % uniqueQueries.length ? 1 : 0);
        const result = await this.request<{ passages: Passage[] }>("/search", { queries: [uniqueQueries[index]], candidateLimit: perQueryBudget, limit: Math.min(limit, perQueryBudget), requestId: requestId() }, retrievalSignal);
        if (!Array.isArray(result.passages) || result.passages.some(p => !p || typeof p.id !== "string" || typeof p.text !== "string" || typeof p.documentId !== "string" || !Number.isInteger(p.version) || typeof p.title !== "string" || !Array.isArray(p.sectionPath))) throw new ServiceUnavailableException("Invalid retrieval response");
        buckets.push(result.passages);
      }
    } finally { clearTimeout(deadline); }
    const chosen = new Map<string, Passage>();
    for (let rank = 0; rank < Math.max(...buckets.map(b => b.length)); rank++) {
      for (const bucket of buckets) {
        const passage = bucket[rank];
        if (passage) chosen.set(passage.id, chosen.get(passage.id) ?? passage);
        if (chosen.size >= limit) break;
      }
      if (chosen.size >= limit) break;
    }
    const passages = [...chosen.values()];
    this.logger.info("RAG evidence retrieved", { requestId: requestId(), passageCount: passages.length, evidenceIds: passages.map(p => p.id).join(","), queryCount: uniqueQueries.length, candidateBudget: candidateLimit });
    return passages;
  }
  async source(documentId: string, version: number) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(documentId) || !Number.isSafeInteger(version) || version < 1) throw new ServiceUnavailableException("Invalid source reference");
    return this.request<{ documentId: string; version: number; title: string; text: string; sourceUrl: string }>(`/documents/${encodeURIComponent(documentId)}/${version}`);
  }
  private async request<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
    const url = process.env.RAG_SERVICE_URL?.trim().replace(/\/+$/, "");
    const token = process.env.RAG_SERVICE_TOKEN?.trim();
    if (!url || !token) {
      this.logger.warn("RAG configuration missing", { requestId: requestId(), reason: !url ? "missing_service_url" : "missing_service_token" });
      throw new ServiceUnavailableException("Retrieval is not configured");
    }
    let serviceOrigin: string;
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Invalid retrieval base URL");
      serviceOrigin = parsed.origin;
    } catch {
      this.logger.warn("RAG configuration invalid", { requestId: requestId(), reason: "invalid_service_url", requirement: "http_or_https_base_url" });
      throw new ServiceUnavailableException("Retrieval URL is not valid");
    }
    const started = Date.now();
    const controller = new AbortController();
    const timeoutMs = path === "/health/ready" ? 10000 : this.searchTimeout();
    const deadline = setTimeout(() => controller.abort(new DOMException("Retrieval timed out", "TimeoutError")), timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      return await this.boundedRequest((async () => {
        const response = await fetch(url + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "X-Rag-Token": token }, body: body ? JSON.stringify(body) : undefined, signal: requestSignal });
        if (!response.ok) {
          this.logger.warn("RAG service HTTP failure", { requestId: requestId(), status: response.status, serviceOrigin, endpoint: path.startsWith("/documents/") ? "source" : path, elapsedMs: Date.now() - started });
          throw new ServiceUnavailableException("Retrieval unavailable");
        }
        return await response.json() as T;
      })(), requestSignal);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.warn("RAG service connection failure", { requestId: requestId(), serviceOrigin, endpoint: path.startsWith("/documents/") ? "source" : path, elapsedMs: Date.now() - started, ...this.connectionDetails(error) });
      throw new ServiceUnavailableException("Retrieval unavailable");
    } finally { clearTimeout(deadline); }
  }

  private searchTimeout(): number {
    const value = Number(process.env.RAG_RETRIEVAL_TIMEOUT_MS ?? 90000);
    if (!Number.isSafeInteger(value) || value < 1000 || value > 180000) throw new ServiceUnavailableException("Invalid retrieval timeout");
    return value;
  }

  private boundedRequest<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
      if (signal.aborted) { abort(); operation.catch(() => {}); return; }
      signal.addEventListener("abort", abort, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private connectionDetails(error: unknown): Record<string, string> {
    const details = { errorType: error instanceof Error ? error.name : "unknown", reason: "connection_failure" } as Record<string, string>;
    if (error instanceof SyntaxError) details.reason = "invalid_service_json";
    else if (error instanceof Error && error.name === "TimeoutError") details.reason = "retrieval_timeout";
    else if (error instanceof Error && error.name === "AbortError") details.reason = "request_aborted";
    const reasons: Record<string, string> = {
      ENOTFOUND: "dns_failure", EAI_AGAIN: "dns_failure", ECONNREFUSED: "connection_refused",
      ECONNRESET: "connection_reset", ETIMEDOUT: "retrieval_timeout", UND_ERR_CONNECT_TIMEOUT: "retrieval_timeout",
      ERR_INVALID_URL: "invalid_service_url", ERR_INVALID_CHAR: "invalid_request_header",
      CERT_HAS_EXPIRED: "tls_failure", UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls_failure",
      DEPTH_ZERO_SELF_SIGNED_CERT: "tls_failure", ERR_TLS_CERT_ALTNAME_INVALID: "tls_failure",
      ERR_SSL_WRONG_VERSION_NUMBER: "tls_failure",
    };
    const cause = (error as { cause?: { code?: unknown; errors?: { code?: unknown }[] } } | null)?.cause;
    const codes = [cause?.code, ...(Array.isArray(cause?.errors) ? cause.errors.slice(0, 10).map(e => e.code) : [])];
    const known = codes.find(code => typeof code === "string" && Object.prototype.hasOwnProperty.call(reasons, code));
    if (typeof known === "string") { details.reason = reasons[known]; details.errorCode = known; }
    return details;
  }

}
