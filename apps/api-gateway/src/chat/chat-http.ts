// Only model inference and read-only retrieval may use these retries. Never wrap
// report mutations: a lost response does not establish that a write failed.
const TRANSIENT_CODES = new Set([
  "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);
const REASONS: Record<string, string> = {
  ENOTFOUND: "dns_failure", EAI_AGAIN: "dns_failure",
  ECONNREFUSED: "connection_refused", ECONNRESET: "connection_reset", UND_ERR_SOCKET: "connection_reset",
  EHOSTUNREACH: "network_unreachable", ENETUNREACH: "network_unreachable",
  ETIMEDOUT: "connection_timeout", UND_ERR_CONNECT_TIMEOUT: "connection_timeout",
  UND_ERR_HEADERS_TIMEOUT: "response_timeout", UND_ERR_BODY_TIMEOUT: "response_timeout",
  CERT_HAS_EXPIRED: "tls_failure", CERT_NOT_YET_VALID: "tls_failure",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls_failure", UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "tls_failure",
  DEPTH_ZERO_SELF_SIGNED_CERT: "tls_failure", SELF_SIGNED_CERT_IN_CHAIN: "tls_failure",
  ERR_TLS_CERT_ALTNAME_INVALID: "tls_failure", ERR_SSL_WRONG_VERSION_NUMBER: "tls_failure",
  ERR_INVALID_URL: "invalid_service_url", ERR_INVALID_CHAR: "invalid_request_header",
};
const ERROR_NAMES = new Set(["Error", "TypeError", "SyntaxError", "AbortError", "TimeoutError", "AggregateError"]);

function inspect(error: unknown): { codes: string[]; interrupted: boolean } {
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  const codes = new Set<string>();
  let interrupted = false;
  for (let index = 0; index < queue.length && index < 24; index++) {
    const item = queue[index];
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const value = item as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    if (typeof value.code === "string") codes.add(value.code);
    if (value.name === "AbortError" || value.name === "TimeoutError") interrupted = true;
    if (value.cause) queue.push(value.cause);
    if (Array.isArray(value.errors)) queue.push(...value.errors.slice(0, 8));
  }
  return { codes: [...codes], interrupted };
}

export function transportFailureDetails(error: unknown): Record<string, string> {
  const name = error instanceof Error ? error.name : "unknown";
  const errorType = ERROR_NAMES.has(name) ? name : "unknown";
  const known = inspect(error).codes.filter(code => Object.prototype.hasOwnProperty.call(REASONS, code));
  // Prefer a permanent/configuration failure if mixed with transient socket errors.
  const errorCode = known.find(code => !TRANSIENT_CODES.has(code)) ?? known[0];
  const reason = errorType === "TimeoutError" ? "request_timeout"
    : errorType === "AbortError" ? "request_aborted"
    : errorType === "SyntaxError" ? "invalid_service_json"
    : errorCode ? REASONS[errorCode] : "connection_failure";
  return { errorType, reason, ...(errorCode ? { errorCode } : {}) };
}

type RetryDetails = Record<string, string | number>;

function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); })
      .then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function backoff(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function withTransportRetries<T>(
  operation: () => Promise<T>, signal: AbortSignal, onRetry?: (details: RetryDetails) => void,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try { return await bounded(operation, signal); }
    catch (error) {
      signal.throwIfAborted();
      const failure = inspect(error);
      if (attempt >= 3 || failure.interrupted || !failure.codes.length ||
          !failure.codes.every(code => TRANSIENT_CODES.has(code))) throw error;
      const delayMs = attempt * 250;
      onRetry?.({ ...transportFailureDetails(error), attempt, nextAttempt: attempt + 1, maxAttempts: 3, delayMs });
      await backoff(delayMs, signal);
    }
  }
}
