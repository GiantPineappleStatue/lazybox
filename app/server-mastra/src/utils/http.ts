import type { IncomingMessage } from "http";

// Safely parse JSON, falling back to text when necessary
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
