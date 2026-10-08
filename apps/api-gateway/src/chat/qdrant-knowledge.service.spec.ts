import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QdrantKnowledgeService } from "./qdrant-knowledge.service";

describe("QdrantKnowledgeService", () => {
  const originalFetch = globalThis.fetch;
  const logger = { setServiceName: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    process.env.QDRANT_URL;
    process.env.QDRANT_COLLECTION;
    process.env.QDRANT_TEXT_FIELD;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.QDRANT_URL;
    delete process.env.QDRANT_COLLECTION;
    delete process.env.QDRANT_TEXT_FIELD;
  });

  it("inspects the payload, creates a text index, and ranks matching passages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { payload_schema: {} } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: {
            points: [{ id: 1, payload: { content: "Lũ quét nguy hiểm" } }],
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: {} }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: {
            points: [
              { id: 2, payload: { content: "Lũ thường kéo dài" } },
              { id: 1, payload: { content: "Lũ quét rất nguy hiểm" } },
            ],
          },
        }),
      });
    globalThis.fetch = fetchMock as never;
    const service = new QdrantKnowledgeService(logger as never);

    const matches = await service.search("Lũ quét nguy hiểm thế nào?");
    expect(matches[0]).toBe("Lũ quét rất nguy hiểm");
    expect(fetchMock.mock.calls[2][0]).toContain("/index?wait=true");
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).field_name).toBe(
      "content",
    );
    const searchBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(searchBody.filter.should[0].key).toBe("content");
    expect(searchBody.with_vector).toBe(false);
  });

  it("retrieves staging points regardless of review metadata", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: { payload_schema: { text: { data_type: "text" } } },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: {
            points: [
              { id: 1, payload: { text: "Ngập lụt", public_retrieval: false } },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: {
            points: [
              { id: 1, payload: { text: "Ngập lụt", public_retrieval: false } },
              {
                id: 2,
                payload: {
                  text: "Ngập lụt",
                  public_retrieval: true,
                  license_status: "REVIEW_REQUIRED",
                },
              },
              {
                id: 3,
                payload: {
                  text: "Ngập lụt",
                  public_retrieval: true,
                  medical_review_required: true,
                },
              },
            ],
          },
        }),
      }) as never;
    const service = new QdrantKnowledgeService(logger as never);
    expect(await service.search("Ngập lụt")).toEqual(["Ngập lụt"]);
  });
});
