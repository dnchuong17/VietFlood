import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { LoggerService } from "vietflood-common";

type QdrantPoint = {
  id: string | number;
  payload?: Record<string, unknown>;
};

type QdrantScroll = {
  result?: { points?: QdrantPoint[] };
};

type QdrantCollection = {
  result?: { payload_schema?: Record<string, { data_type?: string } | string> };
};

const TEXT_FIELDS = [
  "content",
  "pageContent",
  "page_content",
  "text",
  "document",
  "metadata.content",
  "metadata.text",
];

const STOPWORDS = new Set([
  "và",
  "là",
  "của",
  "cho",
  "có",
  "tôi",
  "bạn",
  "làm",
  "sao",
  "thế",
  "nào",
  "khi",
  "một",
  "những",
  "trong",
  "được",
  "cần",
  "về",
  "với",
  "the",
  "what",
  "how",
  "and",
  "for",
  "are",
  "can",
  "should",
  "please",
]);

function valueAtPath(payload: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    return (value as Record<string, unknown>)[segment];
  }, payload);
}

function terms(text: string): string[] {
  return [
    ...new Set(
      (text.toLocaleLowerCase("vi").match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (part) => part.length >= 2 && !STOPWORDS.has(part),
      ),
    ),
  ];
}

@Injectable()
export class QdrantKnowledgeService {
  private readonly textFields = new Map<string, string>();
  private readonly initializations = new Map<string, Promise<string>>();

  constructor(private readonly logger: LoggerService) {
    this.logger.setServiceName(QdrantKnowledgeService.name);
  }

  async search(question: string): Promise<string[]> {
    return this.searchCollection(
      question,
      process.env.QDRANT_COLLECTION?.trim() || "flood_kb_staging_2026_01",
    );
  }

  async searchApproved(question: string): Promise<string[]> {
    const collection = process.env.QDRANT_CHAT_COLLECTION?.trim();
    const localCollection = process.env.QDRANT_COLLECTION?.trim() || "flood_kb_staging_2026_01";
    if (!collection || collection === localCollection) return [];
    return this.searchCollection(question, collection);
  }

  private async searchCollection(question: string, collection: string): Promise<string[]> {
    const field = await this.ensureTextField(collection);
    const queryTerms = terms(question).slice(0, 8);
    if (queryTerms.length === 0) return [];

    const response = await this.request<QdrantScroll>(
      "/points/scroll",
      "POST",
      {
        filter: {
          should: queryTerms.map((term) => ({
            key: field,
            match: { text: term },
          })),
        },
        limit: 100,
        with_payload: true,
        with_vector: false,
      },
      collection,
    );

    const candidates = (response.result?.points ?? []).map((point) => {
      const content = point.payload && valueAtPath(point.payload, field);
      if (typeof content !== "string") return { content: "", score: 0 };
      const candidateTerms = new Set(terms(content));
      const score = queryTerms.reduce(
        (count, term) => count + Number(candidateTerms.has(term)),
        0,
      );
      return { content: content.trim(), score };
    });
    const minimumScore = Math.ceil(queryTerms.length * 0.6);

    const unique = new Map<string, { content: string; score: number }>();
    for (const candidate of candidates
      .filter(
        (candidate) =>
          candidate.content && candidate.score >= minimumScore,
      )
      .sort((left, right) => right.score - left.score)) {
      if (!unique.has(candidate.content))
        unique.set(candidate.content, candidate);
    }

    return [...unique.values()]
      .slice(0, 4)
      .map((candidate) => candidate.content.slice(0, 1800));
  }

  private async ensureTextField(collection: string): Promise<string> {
    const cached = this.textFields.get(collection);
    if (cached) return cached;
    if (!this.initializations.has(collection)) {
      this.initializations.set(collection, this.initialize(collection).catch((error) => {
        this.initializations.delete(collection);
        throw error;
      }));
    }
    return this.initializations.get(collection)!;
  }

  private async initialize(collection: string): Promise<string> {
    const response = await this.request<QdrantCollection>("", "GET", undefined, collection);
    const sample = await this.request<QdrantScroll>("/points/scroll", "POST", {
      limit: 1,
      with_payload: true,
      with_vector: false,
    }, collection);
    const payload = sample.result?.points?.[0]?.payload;
    const configured = process.env.QDRANT_TEXT_FIELD?.trim();
    const field =
      configured ||
      (payload &&
        TEXT_FIELDS.find((name) => {
          const value = valueAtPath(payload, name);
          return typeof value === "string" && value.trim().length > 0;
        }));

    if (!field) {
      this.logger.warn("Qdrant text field unavailable; configure QDRANT_TEXT_FIELD");
      throw new ServiceUnavailableException("Knowledge base text field is not configured");
    }

    if (payload && typeof valueAtPath(payload, field) !== "string") {
      throw new ServiceUnavailableException("Configured Qdrant text field is not present in the collection");
    }

    const schema = response.result?.payload_schema?.[field];
    const isTextIndex = schema === "text" || (typeof schema === "object" && schema?.data_type === "text");
    if (!isTextIndex) {
      await this.request("/index?wait=true", "PUT", {
        field_name: field,
        field_schema: { type: "text", tokenizer: "word", lowercase: true },
      }, collection);
    }

    this.textFields.set(collection, field);
    return field;
  }

  private async request<T>(
    suffix: string,
    method: "GET" | "POST" | "PUT",
    body?: object,
    collection = process.env.QDRANT_COLLECTION?.trim() || "flood_kb_staging_2026_01",
  ): Promise<T> {
    const url = process.env.QDRANT_URL?.replace(/\/$/, "");
    if (!url)
      throw new ServiceUnavailableException("Knowledge base is not configured");

    try {
      const response = await fetch(
        `${url}/collections/${encodeURIComponent(collection)}${suffix}`,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(process.env.QDRANT_API_KEY
              ? { "api-key": process.env.QDRANT_API_KEY }
              : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!response.ok) throw new Error(`Qdrant HTTP ${response.status}`);
      return (await response.json()) as T;
    } catch {
      this.logger.warn("Knowledge base request failed");
      throw new ServiceUnavailableException("Knowledge base is unavailable");
    }
  }
}
