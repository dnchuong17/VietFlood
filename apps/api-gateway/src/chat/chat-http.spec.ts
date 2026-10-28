import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { transportFailureDetails, withTransportRetries } from "./chat-http";
import { OpenAIChatService } from "./openai-chat.service";
import { QdrantKnowledgeService } from "./qdrant-knowledge.service";
import { RagAnswerService } from "./rag-answer.service";

const networkError = (code = "ETIMEDOUT") => Object.assign(new TypeError("private upstream URL and token"), { cause: { code } });
const signal = () => new AbortController().signal;
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it.each(["ETIMEDOUT", "EAI_AGAIN", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"])("recovers from transient %s", async code => {
  vi.useFakeTimers();
  const operation = vi.fn().mockRejectedValueOnce(networkError(code)).mockResolvedValue("ready");
  const result = withTransportRetries(operation, signal());
  await vi.advanceTimersByTimeAsync(250);
  expect(await result).toBe("ready");
  expect(operation).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("recognizes nested aggregate socket errors and emits only safe retry metadata", async () => {
  vi.useFakeTimers();
  const failure = new TypeError("private-token private-query", { cause: new AggregateError([networkError()], "private-address") });
  const operation = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(true);
  const onRetry = vi.fn();
  const result = withTransportRetries(operation, signal(), onRetry);
  await vi.advanceTimersByTimeAsync(250);
  expect(await result).toBe(true);
  expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "ETIMEDOUT", reason: "connection_timeout", attempt: 1, nextAttempt: 2, maxAttempts: 3 }));
  expect(JSON.stringify(onRetry.mock.calls)).not.toMatch(/private-token|private-query|private-address|upstream URL/);
});

it("caps persistent transport failures at three attempts", async () => {
  vi.useFakeTimers();
  const error = networkError();
  const operation = vi.fn().mockRejectedValue(error);
  const assertion = expect(withTransportRetries(operation, signal())).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(750);
  await assertion;
  expect(operation).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["ENOTFOUND", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_INVALID_URL", "UNKNOWN_PRIVATE_CODE"])("does not retry permanent or unknown %s", async code => {
  const error = networkError(code);
  const operation = vi.fn().mockRejectedValue(error);
  await expect(withTransportRetries(operation, signal())).rejects.toBe(error);
  expect(operation).toHaveBeenCalledTimes(1);
});

it("does not retry ordinary errors, invalid JSON or HTTP failures", async () => {
  for (const error of [new Error("HTTP 401"), new SyntaxError("private response"), new DOMException("cancelled", "AbortError"), new DOMException("expired", "TimeoutError")]) {
    const operation = vi.fn().mockRejectedValue(error);
    await expect(withTransportRetries(operation, signal())).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  }
});

it("does not retry mixed TLS and transient aggregate failures", async () => {
  const error = new TypeError("fetch failed", { cause: new AggregateError([networkError(), networkError("CERT_HAS_EXPIRED")]) });
  const operation = vi.fn().mockRejectedValue(error);
  await expect(withTransportRetries(operation, signal())).rejects.toBe(error);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(transportFailureDetails(error)).toMatchObject({ errorCode: "CERT_HAS_EXPIRED", reason: "tls_failure" });
});

it("does not start work for an already cancelled caller", async () => {
  const caller = new AbortController(); caller.abort(new Error("caller cancelled"));
  const operation = vi.fn();
  await expect(withTransportRetries(operation, caller.signal)).rejects.toThrow("caller cancelled");
  expect(operation).not.toHaveBeenCalled();
});

it("cancels immediately during backoff without another attempt", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const operation = vi.fn().mockRejectedValue(networkError());
  const assertion = expect(withTransportRetries(operation, caller.signal)).rejects.toThrow("caller cancelled");
  await vi.advanceTimersByTimeAsync(0);
  caller.abort(new Error("caller cancelled"));
  await assertion;
  expect(operation).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("shares the deadline across transport retries instead of resetting it", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  setTimeout(() => caller.abort(new DOMException("original deadline", "TimeoutError")), 300);
  const operation = vi.fn().mockRejectedValue(networkError());
  const assertion = expect(withTransportRetries(operation, caller.signal)).rejects.toThrow("original deadline");
  await vi.advanceTimersByTimeAsync(300);
  await assertion;
  expect(operation).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds an operation that ignores cancellation", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  setTimeout(() => caller.abort(new DOMException("deadline", "TimeoutError")), 100);
  const operation = vi.fn(() => new Promise(() => {}));
  const assertion = expect(withTransportRetries(operation, caller.signal)).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(100);
  await assertion;
  expect(operation).toHaveBeenCalledTimes(1);
});

it("returns a grounded reply through real services after local action and retrieval socket failures", async () => {
  // All upstream data is explicitly synthetic. No production credentials,
  // model calls, corpus reads or report writes are involved.
  const attempts = { action: 0, search: 0 };
  const text = "Đây là nội dung kiểm thử kết nối nội bộ.";
  const passage = { id: "fixture-passage", documentId: "fixture-doc", version: 1, title: "Synthetic transport fixture", text, sectionPath: [], sourceUrl: "https://example.invalid/fixture", chunkHash: "fixture-hash" };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      let result: unknown;
      if (request.url === "/search") {
        if (++attempts.search === 1) { request.socket.destroy(); return; }
        result = { passages: [passage] };
      } else if (request.url === "/v1/chat/completions") {
        const data = JSON.parse(body.messages[1].content);
        let content: object;
        if (data.message) {
          if (++attempts.action === 1) { request.socket.destroy(); return; }
          content = { intent: "none", arguments: {} };
        } else if (data.claims) content = { checks: [{ index: 0, supported: true, evidence: [{ sourceId: "K1", quote: text }] }] };
        else if (data.evidence) content = { claims: [{ text, sourceIds: ["K1"] }] };
        else if (data.passages) content = { sufficient: true, supportedIds: [passage.id], missingParts: [], nextQueries: [] };
        else content = { route: "static", queries: ["synthetic connectivity fixture"], dynamicParts: [] };
        result = { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] };
      } else { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubEnv("OPENAI_BASE_URL", origin + "/v1"); vi.stubEnv("OPENAI_API_KEY", "synthetic-local-key");
    vi.stubEnv("RAG_SERVICE_URL", origin); vi.stubEnv("RAG_SERVICE_TOKEN", "synthetic-local-token");
    const logger = { setServiceName: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const model = new OpenAIChatService(logger as never);
    const knowledge = new QdrantKnowledgeService(logger as never);
    expect(await model.understandAction("synthetic connectivity fixture", "citizen")).toEqual({ intent: "none", arguments: {} });
    const reply = await new RagAnswerService(knowledge, model, logger as never).reply("synthetic connectivity fixture");
    expect(reply).toMatchObject({ status: "answered", generationMode: "grounded_synthesis", answer: text + " [1]" });
    expect(reply.sources).toHaveLength(1);
    expect(attempts).toEqual({ action: 2, search: 2 });
    expect(logger.warn).toHaveBeenCalledWith("RAG model transport retry", expect.objectContaining({ stage: "action" }));
    expect(logger.warn).toHaveBeenCalledWith("RAG service transport retry", expect.objectContaining({ endpoint: "/search" }));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/synthetic-local-key|synthetic-local-token/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it("recovers over real local HTTP after a socket is closed before a response", async () => {
  const caller = new AbortController();
  const deadline = setTimeout(() => caller.abort(), 3000);
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (requests === 1) { request.socket.destroy(); return; }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ready":true}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const result = await withTransportRetries(async () => {
      const response = await fetch(url, { signal: caller.signal });
      return response.json();
    }, caller.signal);
    expect(result).toEqual({ ready: true });
    expect(requests).toBe(2);
  } finally {
    clearTimeout(deadline);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
