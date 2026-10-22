// Normalized Cloudflare API error type. The Installer never surfaces raw API
// bodies to the browser; callers receive a stable `kind` plus optional status
// and retry-after. Any raw details are retained only for server-side logs.

export type CloudflareErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "rate-limited"
  | "server"
  | "network"
  | "invalid-response"
  | "unknown";

export interface CloudflareErrorDetail {
  code?: number;
  message?: string;
}

export interface CloudflareApiError extends Error {
  kind: CloudflareErrorKind;
  status?: number;
  retryAfterSeconds?: number;
  detail?: CloudflareErrorDetail;
}

function toKind(status: number | undefined): CloudflareErrorKind {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 409:
      return "conflict";
    case 429:
      return "rate-limited";
    default:
      return status !== undefined && status >= 500 ? "server" : "unknown";
  }
}

function messageFor(kind: CloudflareErrorKind, detailMessage?: string): string {
  if (detailMessage) {
    return detailMessage;
  }
  switch (kind) {
    case "unauthorized":
      return "Cloudflare API rejected the credentials";
    case "forbidden":
      return "Cloudflare API denied access";
    case "not-found":
      return "Cloudflare resource was not found";
    case "conflict":
      return "Cloudflare resource state conflict";
    case "rate-limited":
      return "Cloudflare rate limit exceeded";
    case "server":
      return "Cloudflare API reported a server error";
    case "network":
      return "Cloudflare API is unreachable";
    case "invalid-response":
      return "Cloudflare API returned an invalid response";
    default:
      return "Cloudflare API error";
  }
}

function toRetryAfterSeconds(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
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

export function makeCloudflareError(
  res: Response,
  body: unknown,
): CloudflareApiError {
  const status = res.status;
  const kind = toKind(status);
  const detail = Array.isArray(body)
    ? undefined
    : ApiErrorDetail(body);
  const message = messageFor(kind, detail?.message);
  const error = new Error(message) as CloudflareApiError;
  error.kind = kind;
  if (status !== undefined) {
    error.status = status;
  }
  if (kind === "rate-limited") {
    error.retryAfterSeconds = toRetryAfterSeconds(res);
  }
  if (detail) {
    error.detail = detail;
  }
  return error;
}

function ApiErrorDetail(body: unknown): CloudflareErrorDetail | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const obj = body as Record<string, unknown>;
  const errors = obj["errors"];
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    if (typeof first === "object" && first !== null) {
      const f = first as Record<string, unknown>;
      return {
        code: typeof f["code"] === "number" ? f["code"] : undefined,
        message: typeof f["message"] === "string" ? f["message"] : undefined,
      };
    }
  }
  return undefined;
}

export function makeNetworkError(error: unknown): CloudflareApiError {
  const fabricated = new Error(`Cloudflare API network error: ${String(error)}`);
  const apiError = fabricated as CloudflareApiError;
  apiError.kind = "network";
  return apiError;
}

export function makeInvalidResponseError(message: string): CloudflareApiError {
  const fabricated = new Error(message);
  const apiError = fabricated as CloudflareApiError;
  apiError.kind = "invalid-response";
  return apiError;
}

// The v4 response envelope every parser receives after JSON decoding.
export interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: unknown[];
  result?: T;
}
