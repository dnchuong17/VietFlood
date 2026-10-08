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
  private textField?: string;
  private initialization?: Promise<string>;

  constructor(private readonly logger: LoggerService) {
    this.logger.setServiceName(QdrantKnowledgeService.name);
  }

  async search(question: string): Promise<string[]> {
    const field = await this.ensureTextField();
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

    const unique = new Map<string, { content: string; score: number }>();
    for (const candidate of candidates
      .filter((candidate) => candidate.content && candidate.score > 0)
      .sort((left, right) => right.score - left.score)) {
      if (!unique.has(candidate.content))
        unique.set(candidate.content, candidate);
    }

    return [...unique.values()]
      .slice(0, 4)
      .map((candidate) => candidate.content.slice(0, 1800));
  }

  private async ensureTextField(): Promise<string> {
    if (this.textField) return this.textField;
    this.initialization ??= this.initialize().catch((error) => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  private async initialize(): Promise<string> {
    const collection = await this.request<QdrantCollection>("", "GET");
    const sample = await this.request<QdrantScroll>("/points/scroll", "POST", {
      limit: 1,
      with_payload: true,
      with_vector: false,
    });
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
      this.logger.warn(
        "Qdrant text field unavailable; configure QDRANT_TEXT_FIELD",
      );
      throw new ServiceUnavailableException(
        "Knowledge base text field is not configured",
      );
    }

    if (payload && typeof valueAtPath(payload, field) !== "string") {
      throw new ServiceUnavailableException(
        "Configured Qdrant text field is not present in the collection",
      );
    }

    const schema = collection.result?.payload_schema?.[field];
    const isTextIndex =
      schema === "text" ||
      (typeof schema === "object" && schema?.data_type === "text");
    if (!isTextIndex) {
      await this.request("/index?wait=true", "PUT", {
        field_name: field,
        field_schema: { type: "text", tokenizer: "word", lowercase: true },
      });
    }

    this.textField = field;
    return field;
  }

  private async request<T>(
    suffix: string,
    method: "GET" | "POST" | "PUT",
    body?: object,
  ): Promise<T> {
    const url = process.env.QDRANT_URL?.replace(/\/$/, "");
    const collection =
      process.env.QDRANT_COLLECTION || "flood_kb_staging_2026_01";
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
