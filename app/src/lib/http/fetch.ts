import { randomUUID } from "node:crypto";

export async function safeJson(res: any): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    try {
      return await res.text();
    } catch {
      return undefined;
    }
  }
}

export function toObj(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return { value: v as unknown } as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type FetchWithRetryOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  idempotencyKey?: string;
  onRetry?: (info: { attempt: number; waitMs: number; reason: "response" | "error"; status?: number }) => void;
};

function shouldRetryResponse(res: Response): boolean {
  if (res.status === 429) return true;
  if (res.status >= 500) return true;
  return false;
}

export async function fetchWithRetry(url: string, opts: FetchWithRetryOptions = {}): Promise<Response> {
  const { method = "GET", headers = {}, body, timeoutMs = 15000, retries = 2, backoffMs = 500, idempotencyKey } = opts;

  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
  const baseHeaders: Record<string, string> = { ...headers };
  if (isMutating && !baseHeaders["X-Idempotency-Key"]) {
    baseHeaders["X-Idempotency-Key"] = idempotencyKey || randomUUID();
  }

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers: baseHeaders, body, signal: controller.signal } as RequestInit);
      clearTimeout(t);
      if (attempt < retries && shouldRetryResponse(res)) {
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        const wait = retryAfter > 0 ? retryAfter * 1000 : backoffMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
        try {
          opts.onRetry?.({ attempt: attempt + 1, waitMs: wait, reason: "response", status: res.status });
        } catch {}
        await sleep(wait);
        attempt++;
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(t);
      if (attempt < retries) {
        const wait = backoffMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
        try {
          opts.onRetry?.({ attempt: attempt + 1, waitMs: wait, reason: "error" });
        } catch {}
        await sleep(wait);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}
