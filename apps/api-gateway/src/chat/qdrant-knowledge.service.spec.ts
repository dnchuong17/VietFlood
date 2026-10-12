import { afterEach, expect, it, vi } from "vitest";
import { QdrantKnowledgeService } from "./qdrant-knowledge.service";
const logger = { setServiceName: vi.fn(), info: vi.fn(), warn: vi.fn() };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
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
