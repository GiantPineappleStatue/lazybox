import { inspect } from "node:util";

export type RetryInfo = { attempt: number; waitMs: number; reason: "response" | "error"; status?: number };

export function logRetry(correlationId: string | undefined, info: RetryInfo, meta?: Record<string, unknown>) {
  try {
    const base = {
      at: new Date().toISOString(),
      evt: "http.retry",
      correlationId,
      attempt: info.attempt,
      waitMs: info.waitMs,
      reason: info.reason,
      status: info.status,
      ...meta,
    };
    // Keep lightweight; users can pipe this to a real logger later.
    console.warn(`[retry] ${base.correlationId ?? "-"} attempt=${base.attempt} waitMs=${base.waitMs} reason=${base.reason} status=${base.status ?? "-"}`);
  } catch {}
}

export function logToolStart(toolId: string, correlationId?: string, input?: unknown) {
  try {
    console.info(`[tool.start] ${toolId} cid=${correlationId ?? "-"} input=${safeInspect(input)}`);
  } catch {}
}

export function logToolEnd(toolId: string, correlationId?: string, ok?: boolean, output?: unknown) {
  try {
    console.info(`[tool.end] ${toolId} cid=${correlationId ?? "-"} ok=${ok ?? "?"} output=${safeInspect(output)}`);
  } catch {}
}

function safeInspect(v: unknown): string {
  try {
    return inspect(v, { depth: 3, breakLength: 120 });
  } catch {
    return "[uninspectable]";
  }
}
