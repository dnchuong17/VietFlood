import { afterEach, expect, it, vi } from "vitest";
import { QdrantKnowledgeService } from "./qdrant-knowledge.service";
const logger = { setServiceName: vi.fn(), info: vi.fn(), warn: vi.fn() };
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("retrieves passages with metadata through the internal service, never scroll or text match", async () => {
  vi.stubEnv("RAG_SERVICE_URL", "http://rag:8001"); vi.stubEnv("RAG_SERVICE_TOKEN", "secret-token");
  const passage = { id: "1", text: "Nguồn", title: "Source", documentId: "E01", version: 1, sectionPath: [] };
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ passages: [passage] }) }));
  vi.stubGlobal("fetch", fetchMock);
  const service = new QdrantKnowledgeService(logger as never);
  expect(await service.retrieve(["query"], 20, 6)).toEqual([passage]);
  expect(fetchMock.mock.calls[0][0]).toBe("http://rag:8001/search");
  expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("scroll");
  expect(JSON.stringify(logger.info.mock.calls)).not.toContain("secret-token");
});
it("reports upstream status without raw body or credentials", async () => {
  vi.stubEnv("RAG_SERVICE_URL", "http://rag:8001"); vi.stubEnv("RAG_SERVICE_TOKEN", "private-key");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403 })));
  await expect(new QdrantKnowledgeService(logger as never).retrieve(["private query"],20,6)).rejects.toThrow();
  expect(JSON.stringify(logger.warn.mock.calls)).toContain('403');
  expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/private-key|private query/);
});
it("rejects incomplete metadata", async () => {
  vi.stubEnv("RAG_SERVICE_URL", "http://rag:8001"); vi.stubEnv("RAG_SERVICE_TOKEN", "token");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ passages: [{ text: "missing id" }] }) })));
  await expect(new QdrantKnowledgeService(logger as never).retrieve(["query"],20,6)).rejects.toThrow();
});

it("rejects a missing URL scheme without logging the raw configured value", async () => {
  vi.stubEnv("RAG_SERVICE_URL", "private.invalid/token-value"); vi.stubEnv("RAG_SERVICE_TOKEN", "secret");
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  await expect(new QdrantKnowledgeService(logger as never).retrieve(["query"],20,6)).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledWith("RAG configuration invalid", expect.objectContaining({ reason: "invalid_service_url" }));
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("token-value");
});
it.each([["ENOTFOUND","dns_failure"],["ECONNREFUSED","connection_refused"],["UNABLE_TO_VERIFY_LEAF_SIGNATURE","tls_failure"]])("reports %s as %s without provider details", async (code,reason) => {
  vi.stubEnv("RAG_SERVICE_URL", "https://rag.example.test"); vi.stubEnv("RAG_SERVICE_TOKEN", "private-token");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new TypeError("private failure message"), { cause: { code } }); }));
  await expect(new QdrantKnowledgeService(logger as never).retrieve(["private query"],20,6)).rejects.toThrow();
  expect(logger.warn).toHaveBeenCalledWith("RAG service connection failure", expect.objectContaining({ reason, errorCode:code, serviceOrigin:"https://rag.example.test" }));
  expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/private-token|private query|private failure message/);
});
it("reports nested socket failures from AggregateError", async () => {
  vi.stubEnv("RAG_SERVICE_URL", "http://localhost:8001"); vi.stubEnv("RAG_SERVICE_TOKEN", "secret");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { errors: [{ code: "ECONNREFUSED" }] } }); }));
  await expect(new QdrantKnowledgeService(logger as never).retrieve(["query"],20,6)).rejects.toThrow();
  expect(logger.warn).toHaveBeenCalledWith("RAG service connection failure", expect.objectContaining({ reason:"connection_refused" }));
});

it("shares the candidate budget across subqueries and preserves coverage", async () => {
  vi.stubEnv("RAG_SERVICE_URL", "http://rag:8001"); vi.stubEnv("RAG_SERVICE_TOKEN", "secret");
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const passage = (id: string) => ({ id, text: "Nguồn", title: "Source", documentId: "E01", version: 1, sectionPath: [] });
    return { ok: true, json: async () => ({ passages: [passage(body.queries[0]),passage("shared")] }) };
  });
  vi.stubGlobal("fetch",fetchMock);
  const passages = await new QdrantKnowledgeService(logger as never).retrieve(["nước","sơ tán","giấy tờ"],20,4);
  expect(fetchMock.mock.calls.map(c => JSON.parse(c[1].body).candidateLimit)).toEqual([7,7,6]);
  expect(fetchMock.mock.calls.map(c => JSON.parse(c[1].body).queries.length)).toEqual([1,1,1]);
  expect(passages.map(p => p.id)).toEqual(["nước","sơ tán","giấy tờ","shared"]);
});
it("enforces the retrieval deadline even when fetch ignores cancellation", async () => {
  vi.useFakeTimers(); vi.stubEnv("RAG_SERVICE_URL", "http://rag:8001"); vi.stubEnv("RAG_SERVICE_TOKEN", "secret");
  vi.stubGlobal("fetch",vi.fn(async () => new Promise(() => {})));
  const result = new QdrantKnowledgeService(logger as never).retrieve(["query"],20,6);
  const assertion = expect(result).rejects.toThrow("Retrieval unavailable");
  await vi.advanceTimersByTimeAsync(90000); await assertion;
  expect(logger.warn).toHaveBeenCalledWith("RAG service connection failure",expect.objectContaining({ reason:"retrieval_timeout", elapsedMs:90000 }));
});
