// Deployment preflight: never print credentials, response bodies or user data.
function endpoint(value, name) {
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
async function request(url, options, timeout = 15000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`dependency_http_${response.status}`);
  return response.json();
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
(async () => {
  let stage = "configuration";
  try {
    const rag = endpoint(process.env.RAG_SERVICE_URL || "", "rag");
    if (!process.env.RAG_SERVICE_TOKEN) throw new Error("missing_rag_token");
    if (!process.env.OPENAI_API_KEY) throw new Error("missing_openai_api_key");
    const model = (process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,149}$/.test(model)) throw new Error("invalid_openai_model");
    endpoint(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1", "openai");
    stage = "redis";
    await checkRedis();
    console.log(JSON.stringify({ stage, status: "ready" }));
    stage = "retrieval";
    const health = await request(rag + "/health/ready", {
      headers: { "X-Rag-Token": process.env.RAG_SERVICE_TOKEN },
    });
    if (
      health.status !== "ready" ||
      health.alias !==
        (process.env.QDRANT_CHAT_COLLECTION || "flood_kb_active") ||
      !(health.pointCount > 0)
    )
      throw new Error("retrieval_not_ready_or_wrong_alias");
    console.log(
      JSON.stringify({
        stage,
        status: "ready",
        alias: health.alias,
        pointCount: health.pointCount,
      }),
    );
    console.log(
      JSON.stringify({ stage: "configuration", status: "ready", provider: "openai", model }),
    );
  } catch (error) {
    const reason =
      /^(invalid_|missing_|dependency_http_|retrieval_not_|openai_)/.test(
        error.message || "",
      )
        ? error.message
        : error.name;
    console.error(JSON.stringify({ stage, status: "unavailable", reason }));
    process.exitCode = 1;
  }
})();
