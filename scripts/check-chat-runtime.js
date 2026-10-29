// Deployment preflight: never print credentials, response bodies or user data.
const { openaiConfiguration, checkOpenAI, openaiFailureDetails } = require("./check-openai-runtime");
const { setTimeout: wait } = require("node:timers/promises");
const RETRYABLE_RETRIEVAL_CODES = new Set([
  "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);
function retrievalFailureDetails(error) {
  const details = openaiFailureDetails(error);
  return { ...details, reason: details.reason.replace(/^openai_/, "retrieval_") };
}
function endpoint(value, name) {
  value = value.trim();
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(`invalid_${name}_url`);
  return value.replace(/\/+$/, "");
}
class RetrievalReadinessError extends Error {
  constructor(reason, details) {
    super(reason);
    this.details = details;
  }
}
function validateRetrieval(health, expectedAlias) {
  const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,160}$/.test(value)
    ? value : value == null ? "[missing]" : "[invalid]";
  const details = {
    expectedAlias: identifier(expectedAlias),
    reportedAlias: identifier(health?.alias),
    reportedStatus: identifier(health?.status),
    pointCount: typeof health?.pointCount === "number" && Number.isFinite(health.pointCount) ? health.pointCount : "[invalid]",
  };
  if (!health || typeof health !== "object" || Array.isArray(health))
    throw new RetrievalReadinessError("retrieval_invalid_health_response", details);
  if (health.status !== "ready") throw new RetrievalReadinessError("retrieval_not_ready", details);
  if (health.alias !== expectedAlias) throw new RetrievalReadinessError("retrieval_alias_mismatch", details);
  if (!Number.isSafeInteger(health.pointCount) || health.pointCount <= 0)
    throw new RetrievalReadinessError("retrieval_empty_or_invalid_point_count", details);
  return { alias: health.alias, pointCount: health.pointCount };
}
async function request(url, options, timeout = 15000) {
  const signal = AbortSignal.timeout(timeout);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const operation = async () => {
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      try {
        const response = await fetch(url, { ...options, signal });
        if (!response.ok) throw new Error(`dependency_http_${response.status}`);
        return await response.json();
      } catch (error) {
        const { errorCodes = [] } = retrievalFailureDetails(error);
        if (signal.aborted || attempt >= 3 || !errorCodes.length ||
            !errorCodes.every(code => RETRYABLE_RETRIEVAL_CODES.has(code))) throw error;
        await wait(attempt * 250, undefined, { signal });
      }
    }
  };
  try { return await Promise.race([operation(), aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
async function checkRedis() {
  const Redis = require("ioredis");
  const port = Number(process.env.REDIS_PORT || 6379);
  const db = Number(process.env.REDIS_DB || 0);
  if (!process.env.REDIS_HOST || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(db) || db < 0)
    throw new Error("invalid_redis_configuration");
  const redis = new Redis({
    host: process.env.REDIS_HOST,
    port,
    db,
    password: process.env.REDIS_PASSWORD,
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  // The preflight reports a safe status below instead of ioredis printing a
  // repeated unhandled connection event when the endpoint is unreachable.
  redis.on("error", () => {});
  try {
    await redis.connect();
    if (await redis.ping() !== "PONG") throw new Error("redis_ping_failed");
  } finally {
    redis.disconnect();
  }
}
async function checkChatRuntime() {
  let stage = "configuration";
  try {
    const rag = endpoint(process.env.RAG_SERVICE_URL || "", "rag");
    const token = (process.env.RAG_SERVICE_TOKEN || "").trim();
    if (!token) throw new Error("missing_rag_token");
    openaiConfiguration();
    stage = "redis";
    await checkRedis();
    console.log(JSON.stringify({ stage, status: "ready" }));
    stage = "retrieval";
    const health = await request(rag + "/health/ready", {
      headers: { "X-Rag-Token": token },
    });
    const expectedAlias = (process.env.QDRANT_CHAT_COLLECTION || "flood_kb_active").trim();
    const retrieval = validateRetrieval(health, expectedAlias);
    console.log(
      JSON.stringify({
        stage,
        status: "ready",
        ...retrieval,
      }),
    );
    stage = "openai";
    const openai = await checkOpenAI();
    console.log(JSON.stringify({ stage, status: "ready", ...openai }));
  } catch (error) {
    const reason =
      /^(invalid_|missing_|dependency_http_|retrieval_|openai_)/.test(
        error.message || "",
      )
        ? error.message
        : error.name;
    console.error(JSON.stringify({ stage, status: "unavailable", reason,
      ...(stage === "openai" ? openaiFailureDetails(error) : {}),
      ...(stage === "retrieval" && !(error instanceof RetrievalReadinessError) &&
        !/^dependency_http_\d{3}$/.test(error.message || "") ? retrievalFailureDetails(error) : {}),
      ...(error instanceof RetrievalReadinessError ? error.details : {}),
    }));
    process.exitCode = 1;
  }
}
module.exports = { validateRetrieval, checkChatRuntime, request };
if (require.main === module) checkChatRuntime();
