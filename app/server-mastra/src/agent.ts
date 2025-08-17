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
  const llm = _opts?.llm;
  // If LLM settings present, attempt structured extraction via OpenAI-compatible API
  if (llm?.apiKey) {
    try {
      const base = (llm.baseUrl && llm.baseUrl.replace(/\/$/, "")) || "https://api.openai.com";
      const model = llm.model || "gpt-4o-mini";
      const url = `${base}/v1/chat/completions`;
      const system =
        "You extract Shopify customer service actions from emails. Return strict JSON with an 'actions' array. Each item: {actionType, payload, summary}. Allowed actionType values: cancel_order, update_address, resend_order. Put any structured details in payload. No prose outside JSON.";
      const user = `Email content:\n\n${content}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content:
                "Respond with JSON only. Example: {\n  \"actions\": [\n    {\n      \"actionType\": \"cancel_order\",\n      \"payload\": {\"order_id\": 12345},\n      \"summary\": \"Customer requests cancellation.\"\n    }\n  ]\n}\n\nNow extract actions for this email:\n\n" + user,
            },
          ],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const contentText: string | undefined = data?.choices?.[0]?.message?.content;
        if (contentText) {
          const parsed = safeParseJson(contentText);
          const actions = coerceActions(parsed);
          if (actions.length) return actions;
        }
      }
    } catch {
      // swallow and fall through to heuristic
    }
  }

  // Fallback heuristics if LLM not configured or parsing failed
  const lower = content.toLowerCase();
  const out: ProposedAction[] = [];
  if (/(cancel|refund).{0,20}order/.test(lower)) {
    out.push({ id: randomUUID(), actionType: "cancel_order", payload: {}, summary: "Customer requests to cancel/refund an order." });
  }
  if (/change|update/.test(lower) && /address|shipping/.test(lower)) {
    out.push({ id: randomUUID(), actionType: "update_address", payload: {}, summary: "Customer requests a shipping address update." });
  }
  if (/resend|replacement/.test(lower)) {
    out.push({ id: randomUUID(), actionType: "resend_order", payload: {}, summary: "Customer requests a resend/replacement." });
  }
  return out;
}

export async function runShopifyAction(params: {
  actionType: string;
  payload: Record<string, unknown>;
  auth: { shop: string; accessToken: string };
}): Promise<
  | { ok: true; message?: string; data?: Record<string, {}> }
  | { ok: false; reason: string; details?: Record<string, {}> }
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
    return { ok: false, reason: "Exception during Shopify call", details: { error: String(e) } as Record<string, {}> };
  }
}

async function safeJson(res: Response) {
  try {
    return await res.json();
  } catch {
    return await res.text();
  }
}

function toObj(v: unknown): Record<string, {}> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, {}>;
  return { value: v as unknown } as Record<string, {}>;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Some providers may wrap JSON in code fences
    const m = text.match(/\{[\s\S]*\}$/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    return null;
  }
}

function coerceActions(parsed: unknown): ProposedAction[] {
  const out: ProposedAction[] = [];
  if (!parsed || typeof parsed !== "object") return out;
  const actions = (parsed as any).actions;
  if (!Array.isArray(actions)) return out;
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    const t = String((a as any).actionType || "");
    const summary = String((a as any).summary || "");
    const allowed = new Set(["cancel_order", "update_address", "resend_order"]);
    if (!allowed.has(t)) continue;
    const payload = toObj((a as any).payload || {});
    out.push({ id: randomUUID(), actionType: t, payload, summary });
  }
  return out;
}
