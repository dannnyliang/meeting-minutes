// 限流/錯誤處理：把 HTTP 失敗分類成可重試 vs 終止，並轉成非技術夥伴看得懂的人話訊息。
// 因為夥伴用免費 tier key，429 限流是核心可靠性需求。

export class ApiError extends Error {
  // kind: "retryable" | "quota_exhausted" | "bad_key" | "too_large" | "overloaded" | "network" | "unknown"
  constructor(kind, userMessage, { status, retryDelayMs, cause } = {}) {
    super(userMessage);
    this.name = "ApiError";
    this.kind = kind;
    this.userMessage = userMessage;
    this.status = status;
    this.retryDelayMs = retryDelayMs;
    this.cause = cause;
  }
}

const MESSAGES = {
  retryable: "免費額度暫時忙碌，自動重試中…",
  quota_exhausted: "今天的免費額度用完了，請明天再試，或到設定改用付費 key。",
  overloaded: "Google 伺服器忙碌，稍後自動重試…",
  bad_key: "Gemini API key 無效，請到設定重新貼上。",
  too_large: "會議檔太大，請改用「直接送影片」或縮短會議。",
  network: "網路連線問題，請稍後重試。",
  unknown: "發生未預期的錯誤，請重試。",
};

// 從 Gemini 429 回應的 error.details 取 RetryInfo.retryDelay（如 "12s"）轉成毫秒。
function parseRetryDelayMs(body) {
  try {
    const details = body?.error?.details || [];
    for (const d of details) {
      if (d["@type"]?.includes("RetryInfo") && d.retryDelay) {
        const m = /([\d.]+)s/.exec(d.retryDelay);
        if (m) return Math.ceil(parseFloat(m[1]) * 1000);
      }
    }
  } catch (_) {}
  return null;
}

// 是否「今日額度用完」而非暫時性限流：粗略以訊息含 per day / daily / RPD 判斷。
function isDailyExhausted(body) {
  const msg = JSON.stringify(body?.error || "").toLowerCase();
  return msg.includes("per day") || msg.includes("daily") || msg.includes("rpd");
}

// 把一個 fetch Response 轉成 ApiError（呼叫端在非 2xx 時呼叫）。
export async function toApiError(resp) {
  let body = null;
  try {
    body = await resp.clone().json();
  } catch (_) {}
  const status = resp.status;
  if (status === 429) {
    if (isDailyExhausted(body)) {
      return new ApiError("quota_exhausted", MESSAGES.quota_exhausted, { status });
    }
    return new ApiError("retryable", MESSAGES.retryable, {
      status,
      retryDelayMs: parseRetryDelayMs(body),
    });
  }
  if (status === 503) return new ApiError("overloaded", MESSAGES.overloaded, { status });
  if (status === 400 || status === 401 || status === 403) {
    return new ApiError("bad_key", MESSAGES.bad_key, { status });
  }
  if (status === 413) return new ApiError("too_large", MESSAGES.too_large, { status });
  return new ApiError("unknown", MESSAGES.unknown, { status });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 對會丟 ApiError 的 async 函式做退避重試。
// 只重試 kind 為 retryable / overloaded / network 的錯誤，照 retryDelay，否則指數退避 + jitter。
export async function withRetry(fn, { maxAttempts = 6, onRetry } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError("network", MESSAGES.network, { cause: err });
      const retryable = ["retryable", "overloaded", "network"].includes(e.kind);
      attempt += 1;
      if (!retryable || attempt >= maxAttempts) throw e;
      const base = e.retryDelayMs ?? Math.min(1000 * 2 ** (attempt - 1), 16000);
      const jitter = Math.floor(Math.random() * 500);
      const waitMs = base + jitter;
      if (onRetry) onRetry({ attempt, waitMs, error: e });
      await sleep(waitMs);
    }
  }
}
