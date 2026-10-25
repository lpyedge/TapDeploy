// Shared wait policy for the two asset uploaders: a retry after a transient
// failure waits for the provider's Retry-After (or a short growing back-off),
// never longer than MAX_RETRY_WAIT_MS, plus a little jitter.

const MAX_RETRY_WAIT_MS = 10_000;
const BASE_BACKOFF_MS = 500;
const MAX_JITTER_MS = 250;

export function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) {
    return Math.ceil(value);
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    return Math.max(1, Math.ceil((parsed - Date.now()) / 1000));
  }
  return undefined;
}

export function waitBeforeRetry(attempt: number, retryAfterSeconds?: number): Promise<void> {
  const base = retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : BASE_BACKOFF_MS * attempt;
  const delay = Math.min(MAX_RETRY_WAIT_MS, base) + Math.floor(Math.random() * MAX_JITTER_MS);
  return new Promise((resolve) => setTimeout(resolve, delay));
}
