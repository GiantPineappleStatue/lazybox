import { randomUUID } from "node:crypto";
// Minimal server-only agent surface, now using Mastra for LLM-driven extraction.
// Keep this file free of client-side imports. Do not import app code from here.
import { Agent } from "@mastra/core";
import { createTool } from "@mastra/core/tools";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

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
  // optional memory routing
  resourceId?: string;
  threadId?: string;
};

export async function proposeFromEmail(
  content: string,
  _opts?: { llm?: LlmOptions },
): Promise<ProposedAction[]> {
  // Define structured output schema for actions
  const ActionsSchema = z.object({
    actions: z
      .array(
        z.object({
          actionType: z.enum(["cancel_order", "update_address", "resend_order"]),
          payload: z.record(z.string(), z.unknown()).default({}),
          summary: z.string().min(1),
        }),
      )
      .default([]),
  });

  // List orders for a customer (by id or email)
  const shopifyListOrdersForCustomer = createTool({
    id: "shopifyListOrdersForCustomer",
    description: "List recent orders for a given customer by id or email.",
    inputSchema: z.object({
      auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
      customerId: z.union([z.string(), z.number()]).optional(),
      email: z.string().email().optional(),
      limit: z.number().min(1).max(50).default(10),
      status: z.enum(["open", "closed", "cancelled", "any"]).default("any"),
    }).refine((v) => Boolean(v.customerId || v.email), { message: "Provide customerId or email" }),
    outputSchema: z.object({ orders: z.array(z.unknown()).default([]) }),
    execute: async ({ context }) => {
      const { auth, customerId, email, limit, status } = context as any;
      const baseUrl = `https://${auth.shop}/admin/api/2024-10`;
      const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
      let cid = customerId;
      if (!cid && email) {
        const cres = await fetch(`${baseUrl}/customers/search.json?query=${encodeURIComponent(`email:${email}`)}&limit=1`, { headers });
        if (!cres.ok) return { orders: [] };
        const cdata = await safeJson(cres);
        cid = Array.isArray((cdata as any)?.customers) && (cdata as any).customers[0]?.id;
        if (!cid) return { orders: [] };
      }
      const res = await fetch(`${baseUrl}/orders.json?customer_id=${cid}&limit=${limit}&status=${status}`, { headers });
      if (!res.ok) return { orders: [] };
      const data = await safeJson(res);
      return { orders: Array.isArray((data as any)?.orders) ? (data as any).orders : [] };
    },
  });



  // Calculate a refund (full or partial)
  const shopifyCalculateRefund = createTool({
    id: "shopifyCalculateRefund",
    description: "Calculate a Shopify refund for an order (full or partial).",
    inputSchema: z.object({
      auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
      orderId: z.union([z.string(), z.number()]),
      mode: z.enum(["full", "partial"]).default("full"),
      refundLineItems: z
        .array(z.object({ line_item_id: z.union([z.string(), z.number()]), quantity: z.number().min(1), restock_type: z.string().optional() }))
        .optional(),
      refundShipping: z.boolean().default(true),
    }),
    outputSchema: z.object({ refund: z.unknown().optional() }),
    execute: async ({ context }) => {
      const { auth, orderId, mode, refundLineItems, refundShipping } = context as any;
      const baseUrl = `https://${auth.shop}/admin/api/2024-10`;
      const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
      let body: any;
      if (mode === "partial") {
        if (!refundLineItems || !Array.isArray(refundLineItems) || refundLineItems.length === 0) {
          return { refund: undefined };
        }
        body = { refund: { refund_line_items: refundLineItems, shipping: refundShipping ? { full_refund: true } : undefined } };
      } else {
        // full refund: build items from order
        const ores = await fetch(`${baseUrl}/orders/${orderId}.json`, { headers });
        if (!ores.ok) return { refund: undefined };
        const order = (await safeJson(ores) as any)?.order;
        if (!order) return { refund: undefined };
        const already = new Map<number, number>();
        for (const r of order.refunds || []) {
          for (const rli of r.refund_line_items || []) {
            const id = Number(rli.line_item_id);
            already.set(id, (already.get(id) || 0) + Number(rli.quantity || 0));
          }
        }
        const rlis = (order.line_items || []).map((li: any) => ({
          line_item_id: li.id,
          quantity: Math.max(0, Number(li.quantity || 0) - (already.get(Number(li.id)) || 0)),
          restock_type: "no_restock",
        })).filter((x: any) => x.quantity > 0);
        body = { refund: { refund_line_items: rlis, shipping: refundShipping ? { full_refund: true } : undefined } };
      }
      const res = await fetch(`${baseUrl}/orders/${orderId}/refunds/calculate.json`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!res.ok) return { refund: undefined };
      const data = await safeJson(res);
      return { refund: (data as any)?.refund };
    },
  });

  // Create a refund using a calculated refund body
  const shopifyCreateRefund = createTool({
    id: "shopifyCreateRefund",
    description: "Create a Shopify refund from a previously calculated refund object.",
    inputSchema: z.object({
      auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
      orderId: z.union([z.string(), z.number()]),
      refund: z.record(z.string(), z.unknown()),
      notify: z.boolean().default(true),
    }),
    outputSchema: z.object({ ok: z.boolean(), message: z.string().optional(), refund: z.unknown().optional() }),
    execute: async ({ context }) => {
      const { auth, orderId, refund, notify } = context as any;
      const baseUrl = `https://${auth.shop}/admin/api/2024-10`;
      const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
      const body = JSON.stringify({ refund: { ...refund, notify } });
      const res = await fetch(`${baseUrl}/orders/${orderId}/refunds.json`, { method: "POST", headers, body });
      if (!res.ok) return { ok: false, message: "Refund creation failed" };
      const data = await safeJson(res);
      return { ok: true, refund: (data as any)?.refund };
    },
  });

  // Get fulfillments for an order
  const shopifyGetFulfillments = createTool({
    id: "shopifyGetFulfillments",
    description: "Retrieve all fulfillments for an order.",
    inputSchema: z.object({
      auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
      orderId: z.union([z.string(), z.number()]),
    }),
    outputSchema: z.object({ fulfillments: z.array(z.unknown()).default([]) }),
    execute: async ({ context }) => {
      const { auth, orderId } = context as any;
      const baseUrl = `https://${auth.shop}/admin/api/2024-10`;
      const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
      const res = await fetch(`${baseUrl}/orders/${orderId}/fulfillments.json`, { headers });
      if (!res.ok) return { fulfillments: [] };
      const data = await safeJson(res);
      const fulfillments = Array.isArray((data as any)?.fulfillments) ? (data as any).fulfillments : [];
      return { fulfillments };
    },
  });

  // Send invoice for a draft order
  const shopifySendDraftInvoice = createTool({
    id: "shopifySendDraftInvoice",
    description: "Send invoice email for a draft order.",
    inputSchema: z.object({
      auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
      draftOrderId: z.union([z.string(), z.number()]),
      toEmail: z.string().email().optional(),
    }),
    outputSchema: z.object({ ok: z.boolean(), message: z.string().optional() }),
    execute: async ({ context }) => {
      const { auth, draftOrderId, toEmail } = context as any;
      const baseUrl = `https://${auth.shop}/admin/api/2024-10`;
      const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
      const body = JSON.stringify({ draft_order_invoice: toEmail ? { to: toEmail } : {} });
      const res = await fetch(`${baseUrl}/draft_orders/${draftOrderId}/send_invoice.json`, { method: "POST", headers, body });
      if (!res.ok) return { ok: false, message: "Failed to send invoice" };
      return { ok: true, message: "Invoice sent" };
    },
  });

  // Get a single order by id
  const shopifyGetOrder = createTool({
    id: "shopifyGetOrder",
    description: "Fetch a Shopify order by id.",
    inputSchema: z.object({
      auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
      orderId: z.union([z.string(), z.number()]),
    }),
    outputSchema: z.object({ order: z.unknown().optional() }),
    execute: async ({ context }) => {
      const { auth, orderId } = context as any;
      const baseUrl = `https://${auth.shop}/admin/api/2024-10`;
      const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
      const res = await fetch(`${baseUrl}/orders/${orderId}.json`, { headers });
      if (!res.ok) return { order: undefined };
      const data = await safeJson(res);
      return { order: (data as any)?.order };
    },
  });

  // Search customers by email
  const shopifyGetCustomerByEmail = createTool({
    id: "shopifyGetCustomerByEmail",
    description: "Find Shopify customers by email.",
    inputSchema: z.object({
      auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
      email: z.string().email(),
      limit: z.number().min(1).max(50).default(5),
    }),
    outputSchema: z.object({ customers: z.array(z.unknown()).default([]) }),
    execute: async ({ context }) => {
      const { auth, email, limit } = context as any;
      const baseUrl = `https://${auth.shop}/admin/api/2024-10`;
      const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
      const res = await fetch(`${baseUrl}/customers/search.json?query=${encodeURIComponent(`email:${email}`)}&limit=${limit}`, { headers });
      if (!res.ok) return { customers: [] };
      const data = await safeJson(res);
      return { customers: Array.isArray((data as any)?.customers) ? (data as any).customers : [] };
    },
  });

  // Cancel order (wrapper)
  const shopifyCancelOrder = createTool({
    id: "shopifyCancelOrder",
    description: "Cancel a Shopify order by id.",
    inputSchema: z.object({
      auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
      orderId: z.union([z.string(), z.number()]),
    }),
    outputSchema: z.object({ ok: z.boolean(), message: z.string().optional() }),
    execute: async ({ context }) => {
      const { auth, orderId } = context as any;
      const res = await runShopifyAction({ actionType: "cancel_order", payload: { order_id: orderId }, auth });
      return { ok: res.ok, message: (res as any).message };
    },
  });

  // Update shipping address (wrapper)
  const shopifyUpdateAddress = createTool({
    id: "shopifyUpdateAddress",
    description: "Update an order's shipping address.",
    inputSchema: z.object({
      auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
      orderId: z.union([z.string(), z.number()]),
      shippingAddress: z.record(z.string(), z.unknown()),
    }),
    outputSchema: z.object({ ok: z.boolean(), message: z.string().optional() }),
    execute: async ({ context }) => {
      const { auth, orderId, shippingAddress } = context as any;
      const res = await runShopifyAction({ actionType: "update_address", payload: { order_id: orderId, shipping_address: shippingAddress }, auth });
      return { ok: res.ok, message: (res as any).message };
    },
  });

  // Create a replacement draft order (free replacement)
  const shopifyCreateReplacementDraftOrder = createTool({
    id: "shopifyCreateReplacementDraftOrder",
    description: "Create a draft order as a free replacement for an existing order.",
    inputSchema: z.object({
      auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
      orderId: z.union([z.string(), z.number()]),
      note: z.string().default("Replacement order at no charge"),
    }),
    outputSchema: z.object({ ok: z.boolean(), draftOrderId: z.union([z.string(), z.number()]).optional(), message: z.string().optional() }),
    execute: async ({ context }) => {
      const { auth, orderId, note } = context as any;
      const baseUrl = `https://${auth.shop}/admin/api/2024-10`;
      const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
      // Load original order
      const orderRes = await fetch(`${baseUrl}/orders/${orderId}.json`, { headers });
      if (!orderRes.ok) return { ok: false, message: "Order not found" };
      const order = (await safeJson(orderRes) as any)?.order;
      if (!order) return { ok: false, message: "Order not found" };
      const line_items = (order.line_items || []).map((li: any) => ({
        variant_id: li.variant_id || undefined,
        quantity: li.quantity || 1,
        applied_discount: { value_type: "percentage", value: "100.0" },
        title: li.title,
      }));
      const draftBody = {
        draft_order: {
          line_items,
          shipping_address: order.shipping_address,
          billing_address: order.billing_address,
          customer: order.customer ? { id: order.customer.id } : undefined,
          note,
          use_customer_default_address: true,
        },
      };
      const res = await fetch(`${baseUrl}/draft_orders.json`, { method: "POST", headers, body: JSON.stringify(draftBody) });
      if (!res.ok) return { ok: false, message: "Draft order creation failed" };
      const data = await safeJson(res);
      const draftOrderId = (data as any)?.draft_order?.id;
      return { ok: true, draftOrderId };
    },
  });

  // Add a note to an order
  const shopifyAddOrderNote = createTool({
    id: "shopifyAddOrderNote",
    description: "Add or update the note on a Shopify order.",
    inputSchema: z.object({
      auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
      orderId: z.union([z.string(), z.number()]),
      note: z.string().min(1),
    }),
    outputSchema: z.object({ ok: z.boolean(), message: z.string().optional() }),
    execute: async ({ context }) => {
      const { auth, orderId, note } = context as any;
      const baseUrl = `https://${auth.shop}/admin/api/2024-10`;
      const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
      const body = JSON.stringify({ order: { id: orderId, note } });
      const res = await fetch(`${baseUrl}/orders/${orderId}.json`, { method: "PUT", headers, body });
      if (!res.ok) return { ok: false, message: "Failed to update note" };
      return { ok: true, message: "Order note updated" };
    },
  });

  // Get summarized order status
  const shopifyGetOrderStatus = createTool({
    id: "shopifyGetOrderStatus",
    description: "Get fulfillment and financial status for an order.",
    inputSchema: z.object({
      auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
      orderId: z.union([z.string(), z.number()]),
    }),
    outputSchema: z.object({ status: z.unknown().optional() }),
    execute: async ({ context }) => {
      const { auth, orderId } = context as any;
      const baseUrl = `https://${auth.shop}/admin/api/2024-10`;
      const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
      const res = await fetch(`${baseUrl}/orders/${orderId}.json`, { headers });
      if (!res.ok) return { status: undefined };
      const data = await safeJson(res);
      const order = (data as any)?.order;
      if (!order) return { status: undefined };
      const status = {
        fulfillment_status: order.fulfillment_status,
        financial_status: order.financial_status,
        cancelled_at: order.cancelled_at,
        closed_at: order.closed_at,
        tags: order.tags,
      };
      return { status };
    },
  });

  // Build a Mastra Agent with OpenAI model, tools, and persistent memory.
  // Note: API key/base URL resolution is expected to be provided via environment for the SDK.
  // We still pass through model name from settings when available.
  const modelName = _opts?.llm?.model || "gpt-4o-mini";
  const baseURL = (_opts?.llm?.baseUrl || "https://api.openai.com").replace(/\/$/, "");
  const apiKey = _opts?.llm?.apiKey;
  const openai = createOpenAI({ baseURL, apiKey });
  const model = openai(modelName);

  // Shared persistent memory store (sqlite file). This instance can be reused per call safely.
  // The file path is relative to the server-mastra package dir.
  const memory = new Memory({
    storage: new LibSQLStore({ url: "file:./memory.db" }),
  });

  // Define a Shopify action tool so the agent can optionally call it in other contexts.
  const shopifyActionTool = createTool({
    id: "shopifyAction",
    description:
      "Execute a Shopify customer support action. Provide 'auth' with shop and accessToken.",
    inputSchema: z.object({
      actionType: z.enum(["cancel_order", "update_address", "resend_order"]),
      payload: z.record(z.string(), z.unknown()).default({}),
      auth: z.object({
        shop: z.string().min(1),
        accessToken: z.string().min(1),
      }),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      message: z.string().optional(),
    }),
    execute: async ({ context }) => {
      const { actionType, payload, auth } = context as {
        actionType: string;
        payload: Record<string, unknown>;
        auth: { shop: string; accessToken: string };
      };
      const result = await runShopifyAction({ actionType, payload, auth });
      return { ok: result.ok, message: (result as any).message };
    },
  });

  const agent = new Agent({
    name: "email-support-agent",
    instructions:
      "You are a Shopify customer support action extractor. Read the email and output actions only.",
    model,
    memory,
    tools: {
      shopifyActionTool,
      shopifyGetOrder,
      shopifyGetCustomerByEmail,
      shopifyCancelOrder,
      shopifyUpdateAddress,
      shopifyCreateReplacementDraftOrder,
      shopifyAddOrderNote,
      shopifyGetOrderStatus,
      shopifyGetFulfillments,
      shopifySendDraftInvoice,
      shopifyListOrdersForCustomer,
      shopifyCalculateRefund,
      shopifyCreateRefund,
    },
  });

  try {
    const messages = [
      {
        role: "system" as const,
        content:
          "Return JSON that strictly matches the output schema. Allowed actionType values: cancel_order, update_address, resend_order. Put details in payload. No extra prose.",
      },
      { role: "user" as const, content: `Email content:\n\n${content}` },
    ];
    const result = await agent.generate(messages, {
      output: ActionsSchema,
      temperature: 0.2,
      maxSteps: 1,
      // Wire through optional memory routing ids to organize threads by user/mail
      memory:
        _opts?.llm?.resourceId && _opts?.llm?.threadId
          ? {
              resource: _opts.llm.resourceId,
              thread: { id: _opts.llm.threadId },
            }
          : undefined,
    });

    const output = (result as unknown as { output?: z.infer<typeof ActionsSchema> }).output;
    const actions = (output?.actions || []).map((a) => ({
      id: randomUUID(),
      actionType: a.actionType,
      payload: (a.payload || {}) as Record<string, {}>,
      summary: a.summary,
    }));
    if (actions.length) return actions;
  } catch {
    // fall through to heuristic
  }

  // Fallback heuristics if LLM not configured or extraction failed
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
      case "resend_order": {
        const orderId = params.payload["order_id"] as string | number | undefined;
        const note = (params.payload["note"] as string | undefined) || "Replacement order at no charge";
        const sendInvoice = Boolean(params.payload["send_invoice"]);
        const invoiceTo = params.payload["invoice_to"] as string | undefined;
        if (!orderId) return { ok: false, reason: "Missing order_id" };

        // Load original order
        const orderRes = await fetch(`${baseUrl}/orders/${orderId}.json`, { headers });
        if (!orderRes.ok) return { ok: false, reason: "Order not found", details: toObj(await safeJson(orderRes)) };
        const order = (await safeJson(orderRes) as any)?.order;
        if (!order) return { ok: false, reason: "Order not found" };

        // Build free replacement draft order
        const line_items = (order.line_items || []).map((li: any) => ({
          variant_id: li.variant_id || undefined,
          quantity: li.quantity || 1,
          applied_discount: { value_type: "percentage", value: "100.0" },
          title: li.title,
        }));
        const draftBody = {
          draft_order: {
            line_items,
            shipping_address: order.shipping_address,
            billing_address: order.billing_address,
            customer: order.customer ? { id: order.customer.id } : undefined,
            note,
            use_customer_default_address: true,
          },
        };
        const draftRes = await fetch(`${baseUrl}/draft_orders.json`, { method: "POST", headers, body: JSON.stringify(draftBody) });
        if (!draftRes.ok) return { ok: false, reason: "Draft order creation failed", details: toObj(await safeJson(draftRes)) };
        const draftData = await safeJson(draftRes);
        const draftOrderId = (draftData as any)?.draft_order?.id;

        // Optionally send invoice
        if (sendInvoice && draftOrderId) {
          const invoiceBody = JSON.stringify({ draft_order_invoice: invoiceTo ? { to: invoiceTo } : {} });
          const invRes = await fetch(`${baseUrl}/draft_orders/${draftOrderId}/send_invoice.json`, { method: "POST", headers, body: invoiceBody });
          if (!invRes.ok) {
            return { ok: true, message: "Replacement draft created; invoice failed to send", data: { draftOrderId } as Record<string, {}> };
          }
        }

        return { ok: true, message: "Replacement draft created", data: { draftOrderId } as Record<string, {}> };
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
