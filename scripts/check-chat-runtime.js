// Deployment preflight: never print credentials, response bodies or user data.
const model = (process.env.OLLAMA_CHAT_MODEL || "qwen3:1.7b-q4_K_M").trim();
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
(async () => {
  let stage = "configuration";
  try {
    const ollama = endpoint(
      process.env.OLLAMA_BASE_URL || "http://ollama:11434",
      "ollama",
    );
    const rag = endpoint(process.env.RAG_SERVICE_URL || "", "rag");
    if (!process.env.RAG_SERVICE_TOKEN) throw new Error("missing_rag_token");
    const context = Number(process.env.OLLAMA_NUM_CTX || 16384);
    if (
      !Number.isSafeInteger(context) ||
      context < 4096 ||
      context > 40960 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,149}$/.test(model)
    )
      throw new Error("invalid_model_configuration");
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
    stage = "ollama_model";
    const tags = await request(ollama + "/api/tags");
    if (
      !tags.models?.some((item) => item.name === model || item.model === model)
    )
      throw new Error("ollama_model_not_installed");
    stage = "ollama_warmup";
    // Empty prompt loads weights without producing an answer or requiring an API key.
    const warm = await request(
      ollama + "/api/generate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: "",
          stream: false,
          keep_alive: "10m",
          options: { num_ctx: context },
        }),
      },
      120000,
    );
    if (warm.done !== true) throw new Error("ollama_warmup_incomplete");
    console.log(
      JSON.stringify({ stage, status: "ready", provider: "ollama", model }),
    );
  } catch (error) {
    const reason =
      /^(invalid_|missing_|dependency_http_|retrieval_not_|ollama_)/.test(
        error.message || "",
      )
        ? error.message
        : error.name;
    console.error(JSON.stringify({ stage, status: "unavailable", reason }));
    process.exitCode = 1;
  }
})();
