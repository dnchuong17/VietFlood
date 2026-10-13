// A small real completion verifies the configured key, model and network.
// Only the static probe below is sent; never print credentials or API bodies.
function openaiConfiguration(env = process.env) {
  const baseUrl = (env.OPENAI_BASE_URL ?? "https://cheapkeyai.shop/v1").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(baseUrl);
    const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((!localHttp && url.protocol !== "https:") || url.username || url.password || url.search || url.hash)
      throw new Error();
  } catch {
    throw new Error("invalid_openai_url");
  }
  const apiKey = (env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("missing_openai_api_key");
  const model = (env.OPENAI_CHAT_MODEL ?? "gpt-5-nano").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,149}$/.test(model)) throw new Error("invalid_openai_model");
  const timeoutMs = Number(env.OPENAI_REQUEST_TIMEOUT_MS ?? 120000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000)
    throw new Error("invalid_openai_limits");
  return { baseUrl, apiKey, model, timeoutMs, serviceOrigin: url.origin };
}

async function checkOpenAI(env = process.env) {
  const config = openaiConfiguration(env);
  const started = Date.now();
  const signal = AbortSignal.timeout(config.timeoutMs);
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const completion = async () => {
    const response = await fetch(config.baseUrl + "/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: 'Return only the JSON object {"ready":true}.' }],
        response_format: { type: "json_object" },
        reasoning_effort: "minimal",
        max_completion_tokens: 1024,
      }),
    });
    if (!response.ok) {
      const reasons = {
        401: "openai_authentication_failed", 403: "openai_permission_denied",
        404: "openai_model_or_endpoint_not_found", 429: "openai_rate_limit_or_quota_exceeded",
      };
      let reason = reasons[response.status] || "openai_http_error";
      if (response.status === 429) {
        const knownCodes = ["insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded", "rate_limit_exceeded", "slow_down"];
        const body = await response.json().catch(() => null);
        const code = body?.error?.code ?? body?.error?.type;
        if (knownCodes.includes(code)) reason = `openai_${code}`;
      }
      throw new Error(`${reason}_${response.status}`);
    }
    const result = await response.json();
    const choice = result?.choices?.[0];
    if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string")
      throw new Error("openai_invalid_probe_response");
    let value;
    try { value = JSON.parse(choice.message.content); }
    catch { throw new Error("openai_invalid_probe_response"); }
    if (value?.ready !== true) throw new Error("openai_invalid_probe_response");
    return { provider: "openai", model: config.model, serviceOrigin: config.serviceOrigin, elapsedMs: Date.now() - started };
  };
  try {
    return await Promise.race([completion(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

module.exports = { openaiConfiguration, checkOpenAI };

if (require.main === module) {
  checkOpenAI().then(
    (result) => console.log(JSON.stringify({ stage: "openai", status: "ready", ...result })),
    (error) => {
      const reason = /^(invalid_|missing_|openai_)/.test(error.message || "") ? error.message : error.name;
      console.error(JSON.stringify({ stage: "openai", status: "unavailable", reason }));
      process.exitCode = 1;
    },
  );
}
