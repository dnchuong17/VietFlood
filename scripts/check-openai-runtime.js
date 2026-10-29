// A small real completion verifies the configured key, model and network.
// Only the static probe below is sent; never print credentials or API bodies.
const { setTimeout: wait } = require("node:timers/promises");

const NETWORK_REASONS = {
  ENOTFOUND: "openai_dns_error", EAI_AGAIN: "openai_dns_error",
  ECONNREFUSED: "openai_connection_refused", ECONNRESET: "openai_connection_reset",
  EHOSTUNREACH: "openai_network_unreachable", ENETUNREACH: "openai_network_unreachable",
  ETIMEDOUT: "openai_connection_timeout", UND_ERR_CONNECT_TIMEOUT: "openai_connection_timeout",
  UND_ERR_HEADERS_TIMEOUT: "openai_connection_timeout", UND_ERR_BODY_TIMEOUT: "openai_connection_timeout",
  UND_ERR_SOCKET: "openai_connection_reset",
  CERT_HAS_EXPIRED: "openai_tls_error", CERT_NOT_YET_VALID: "openai_tls_error",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "openai_tls_error",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "openai_tls_error",
  DEPTH_ZERO_SELF_SIGNED_CERT: "openai_tls_error", SELF_SIGNED_CERT_IN_CHAIN: "openai_tls_error",
  ERR_TLS_CERT_ALTNAME_INVALID: "openai_tls_error",
};
const RETRYABLE_CODES = new Set([
  "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

function openaiFailureDetails(error) {
  // Undici can nest socket errors inside cause / AggregateError.errors. Only
  // copy known codes, never messages, URLs, addresses, headers, or response data.
  const queue = [error];
  const seen = new Set();
  const codes = new Set();
  for (let i = 0; i < queue.length && i < 24; i++) {
    const item = queue[i];
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (typeof item.code === "string" && Object.hasOwn(NETWORK_REASONS, item.code)) codes.add(item.code);
    if (item.cause) queue.push(item.cause);
    if (Array.isArray(item.errors)) queue.push(...item.errors.slice(0, 8));
  }
  const errorCodes = [...codes];
  const errorCode = errorCodes[0];
  const errorType = ["TypeError", "Error", "SyntaxError", "TimeoutError", "AbortError", "AggregateError"].includes(error?.name)
    ? error.name : "Error";
  let reason;
  if (errorType === "TimeoutError") reason = "openai_timeout";
  else if (errorType === "AbortError") reason = "openai_aborted";
  else if (errorCode) reason = NETWORK_REASONS[errorCode];
  else if (errorType === "SyntaxError") reason = "openai_invalid_response_json";
  else if (/^(invalid_|missing_|openai_)[a-z0-9_]{1,100}$/.test(error?.message || "")) reason = error.message;
  else reason = errorType === "TypeError" && error.message === "fetch failed"
    ? "openai_connection_failed" : "openai_probe_failed";
  return { reason, errorType, ...(errorCode ? { errorCode, errorCodes } : {}) };
}

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
  const model = (env.OPENAI_CHAT_MODEL ?? "gpt-4.1-nano-2025-04-14").trim();
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
  let attempts = 0;
  const completion = async () => {
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      attempts++;
      try {
        const body = {
          model: config.model,
          messages: [{ role: "user", content: 'Return only the JSON object {"ready":true}.' }],
          response_format: { type: "json_object" },
          max_completion_tokens: 1024,
          ...( /^gpt-5(?:[.-]|$)/i.test(config.model) ? { reasoning_effort: "minimal" } : {}),
        };
        response = await fetch(config.baseUrl + "/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
          signal,
          body: JSON.stringify(body),
        });
        break;
      } catch (error) {
        const { errorCodes = [] } = openaiFailureDetails(error);
        if (signal.aborted || attempt === 2 || !errorCodes.length ||
            !errorCodes.every((code) => RETRYABLE_CODES.has(code))) throw error;
        await wait(500 * (attempt + 1), undefined, { signal });
      }
    }
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
    return { provider: "openai", model: config.model, serviceOrigin: config.serviceOrigin, attempts, elapsedMs: Date.now() - started };
  };
  try {
    return await Promise.race([completion(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

module.exports = { openaiConfiguration, checkOpenAI, openaiFailureDetails };

if (require.main === module) {
  checkOpenAI().then(
    (result) => console.log(JSON.stringify({ stage: "openai", status: "ready", ...result })),
    (error) => {
      console.error(JSON.stringify({ stage: "openai", status: "unavailable", ...openaiFailureDetails(error) }));
      process.exitCode = 1;
    },
  );
}
