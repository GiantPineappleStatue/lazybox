import { randomUUID } from "node:crypto";
// Minimal server-only agent surface. Replace internals with real Mastra logic later.
// Keep this file free of client-side imports. Do not import app code from here.

export type ProposedAction = {
  id: string;
  actionType: string;
  payload: Record<string, {}>;
  summary: string;
};

export type LlmOptions = {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
};

export async function proposeFromEmail(
  content: string,
  _opts?: { llm?: LlmOptions },
): Promise<ProposedAction[]> {
  const lower = content.toLowerCase();
  const out: ProposedAction[] = [];

  if (/(cancel|refund).{0,20}order/.test(lower)) {
    out.push({
      id: randomUUID(),
      actionType: "cancel_order",
      payload: {},
      summary: "Customer requests to cancel/refund an order.",
    });
  }

  if (/change|update/.test(lower) && /address|shipping/.test(lower)) {
    out.push({
      id: randomUUID(),
      actionType: "update_address",
      payload: {},
      summary: "Customer requests a shipping address update.",
    });
  }

  if (/resend|replacement/.test(lower)) {
    out.push({
      id: randomUUID(),
      actionType: "resend_order",
      payload: {},
      summary: "Customer requests a resend/replacement.",
    });
  }

  return out;
}

export async function runShopifyAction(params: {
  actionType: string;
  payload: Record<string, unknown>;
  auth: { shop: string; accessToken: string };
}): Promise<
  | { ok: true; message?: string; data?: Record<string, unknown> }
  | { ok: false; reason: string; details?: Record<string, unknown> }
> {
  const baseUrl = `https://${params.auth.shop}/admin/api/2024-10`;
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": params.auth.accessToken,
  } as const;

  try {
    switch (params.actionType) {
      case "cancel_order": {
        const orderId = params.payload["order_id"] as string | number | undefined;
        if (!orderId) return { ok: false, reason: "Missing order_id" };
        const res = await fetch(`${baseUrl}/orders/${orderId}/cancel.json`, {
          method: "POST",
          headers,
        });
        if (!res.ok) return { ok: false, reason: "Shopify cancel failed", details: toObj(await safeJson(res)) };
        return { ok: true, message: "Order cancelled", data: toObj(await safeJson(res)) };
      }
      case "update_address": {
        const orderId = params.payload["order_id"] as string | number | undefined;
        const address = params.payload["shipping_address"] as Record<string, unknown> | undefined;
        if (!orderId || !address) return { ok: false, reason: "Missing order_id or shipping_address" };
        const body = JSON.stringify({ order: { id: orderId, shipping_address: address } });
        const res = await fetch(`${baseUrl}/orders/${orderId}.json`, {
          method: "PUT",
          headers,
          body,
        });
        if (!res.ok) return { ok: false, reason: "Shopify address update failed", details: toObj(await safeJson(res)) };
        return { ok: true, message: "Shipping address updated", data: toObj(await safeJson(res)) };
      }
      default:
        return { ok: false, reason: "Unsupported actionType" };
    }
  } catch (e) {
    return { ok: false, reason: "Exception during Shopify call", details: { error: String(e) } };
  }
}

async function safeJson(res: Response) {
  try {
    return await res.json();
  } catch {
    return await res.text();
  }
}

function toObj(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return { value: v as unknown } as Record<string, unknown>;
}
