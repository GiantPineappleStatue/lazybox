import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { safeJson, fetchWithRetry } from "../utils/http.js";
import { buildReplacementDraftBody, runShopifyAction, shopifyApiBase, isValidShopDomain } from "./helpers.js";
import { randomUUID } from "node:crypto";
import { logToolEnd, logToolStart } from "../observability/logger.js";

function redactAuth(input: unknown): unknown {
  try {
    if (!input || typeof input !== "object") return input;
    const clone = JSON.parse(JSON.stringify(input));
    if (clone?.auth?.accessToken) clone.auth.accessToken = "[REDACTED]";
    return clone;
  } catch {
    return input;
  }
}

export const shopifyListOrdersForCustomer = createTool({
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
  execute: async ({ context }: { context: any }) => {
    const corrId = randomUUID();
    logToolStart("shopifyListOrdersForCustomer", corrId, redactAuth(context));
    const { auth, customerId, email, limit, status } = context as any;
    if (!isValidShopDomain(auth.shop)) return { orders: [] };
    const baseUrl = shopifyApiBase(auth.shop);
    const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
    let resolvedCustomerId = customerId;
    if (!resolvedCustomerId && email) {
      const cres = await fetchWithRetry(`${baseUrl}/customers/search.json?query=${encodeURIComponent(`email:${email}`)}&limit=1`, { headers: { ...headers }, correlationId: corrId });
      if (!cres.ok) return { orders: [] };
      const cdata = await safeJson(cres);
      resolvedCustomerId = Array.isArray((cdata as any)?.customers) && (cdata as any).customers[0]?.id;
      if (!resolvedCustomerId) return { orders: [] };
    }
    const res = await fetchWithRetry(`${baseUrl}/orders.json?customer_id=${resolvedCustomerId}&limit=${limit}&status=${status}`, { headers: { ...headers }, correlationId: corrId });
    if (!res.ok) return { orders: [] };
    const data = await safeJson(res);
    const out = { orders: Array.isArray((data as any)?.orders) ? (data as any).orders : [] };
    logToolEnd("shopifyListOrdersForCustomer", corrId, true, out);
    return out;
  },
});

export const shopifyCalculateRefund = createTool({
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
  execute: async ({ context }: { context: any }) => {
    const cid = randomUUID();
    logToolStart("shopifyCalculateRefund", cid, redactAuth(context));
    const { auth, orderId, mode, refundLineItems, refundShipping } = context as any;
    if (!isValidShopDomain(auth.shop)) return { refund: undefined };
    const baseUrl = shopifyApiBase(auth.shop);
    const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
    let body: any;
    if (mode === "partial") {
      if (!refundLineItems || !Array.isArray(refundLineItems) || refundLineItems.length === 0) {
        return { refund: undefined };
      }
      body = { refund: { refund_line_items: refundLineItems, shipping: refundShipping ? { full_refund: true } : undefined } };
    } else {
      const ores = await fetchWithRetry(`${baseUrl}/orders/${orderId}.json`, { headers: { ...headers }, correlationId: cid });
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
    const res = await fetchWithRetry(`${baseUrl}/orders/${orderId}/refunds/calculate.json`, { method: "POST", headers: { ...headers }, body: JSON.stringify(body), correlationId: cid });
    if (!res.ok) return { refund: undefined };
    const data = await safeJson(res);
    const out = { refund: (data as any)?.refund };
    logToolEnd("shopifyCalculateRefund", cid, true, out);
    return out;
  },
});

export const shopifyCreateRefund = createTool({
  id: "shopifyCreateRefund",
  description: "Create a Shopify refund from a previously calculated refund object.",
  inputSchema: z.object({
    auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
    orderId: z.union([z.string(), z.number()]),
    refund: z.record(z.string(), z.unknown()),
    notify: z.boolean().default(true),
  }),
  outputSchema: z.object({ ok: z.boolean(), message: z.string().optional(), refund: z.unknown().optional() }),
  execute: async ({ context }: { context: any }) => {
    const cid = randomUUID();
    logToolStart("shopifyCreateRefund", cid, redactAuth(context));
    const { auth, orderId, refund, notify } = context as any;
    if (!isValidShopDomain(auth.shop)) return { ok: false, message: "Invalid shop domain" };
    const baseUrl = shopifyApiBase(auth.shop);
    const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
    const body = JSON.stringify({ refund: { ...refund, notify } });
    const res = await fetchWithRetry(`${baseUrl}/orders/${orderId}/refunds.json`, { method: "POST", headers: { ...headers }, body, correlationId: cid });
    if (!res.ok) return { ok: false, message: "Refund creation failed" };
    const data = await safeJson(res);
    const out = { ok: true, refund: (data as any)?.refund };
    logToolEnd("shopifyCreateRefund", cid, true, out);
    return out;
  },
});

export const shopifyGetFulfillments = createTool({
  id: "shopifyGetFulfillments",
  description: "Retrieve all fulfillments for an order.",
  inputSchema: z.object({
    auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
    orderId: z.union([z.string(), z.number()]),
  }),
  outputSchema: z.object({ fulfillments: z.array(z.unknown()).default([]) }),
  execute: async ({ context }: { context: any }) => {
    const cid = randomUUID();
    logToolStart("shopifyGetFulfillments", cid, redactAuth(context));
    const { auth, orderId } = context as any;
    if (!isValidShopDomain(auth.shop)) return { fulfillments: [] };
    const baseUrl = shopifyApiBase(auth.shop);
    const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
    const res = await fetchWithRetry(`${baseUrl}/orders/${orderId}/fulfillments.json`, { headers: { ...headers }, correlationId: cid });
    if (!res.ok) return { fulfillments: [] };
    const data = await safeJson(res);
    const fulfillments = Array.isArray((data as any)?.fulfillments) ? (data as any).fulfillments : [];
    const out = { fulfillments };
    logToolEnd("shopifyGetFulfillments", cid, true, out);
    return out;
  },
});

export const shopifySendDraftInvoice = createTool({
  id: "shopifySendDraftInvoice",
  description: "Send invoice email for a draft order.",
  inputSchema: z.object({
    auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
    draftOrderId: z.union([z.string(), z.number()]),
    toEmail: z.string().email().optional(),
  }),
  outputSchema: z.object({ ok: z.boolean(), message: z.string().optional() }),
  execute: async ({ context }: { context: any }) => {
    const cid = randomUUID();
    logToolStart("shopifySendDraftInvoice", cid, redactAuth(context));
    const { auth, draftOrderId, toEmail } = context as any;
    if (!isValidShopDomain(auth.shop)) return { ok: false, message: "Invalid shop domain" };
    const baseUrl = shopifyApiBase(auth.shop);
    const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
    const body = JSON.stringify({ draft_order_invoice: toEmail ? { to: toEmail } : {} });
    const res = await fetchWithRetry(`${baseUrl}/draft_orders/${draftOrderId}/send_invoice.json`, { method: "POST", headers: { ...headers }, body, correlationId: cid });
    if (!res.ok) return { ok: false, message: "Failed to send invoice" };
    const out = { ok: true, message: "Invoice sent" };
    logToolEnd("shopifySendDraftInvoice", cid, true, out);
    return out;
  },
});

export const shopifyGetOrder = createTool({
  id: "shopifyGetOrder",
  description: "Fetch a Shopify order by id.",
  inputSchema: z.object({
    auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
    orderId: z.union([z.string(), z.number()]),
  }),
  outputSchema: z.object({ order: z.unknown().optional() }),
  execute: async ({ context }: { context: any }) => {
    const cid = randomUUID();
    logToolStart("shopifyGetOrder", cid, redactAuth(context));
    const { auth, orderId } = context as any;
    if (!isValidShopDomain(auth.shop)) return { order: undefined };
    const baseUrl = shopifyApiBase(auth.shop);
    const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
    const res = await fetchWithRetry(`${baseUrl}/orders/${orderId}.json`, { headers: { ...headers }, correlationId: cid });
    if (!res.ok) return { order: undefined };
    const data = await safeJson(res);
    const out = { order: (data as any)?.order };
    logToolEnd("shopifyGetOrder", cid, true, out);
    return out;
  },
});

export const shopifyGetCustomerByEmail = createTool({
  id: "shopifyGetCustomerByEmail",
  description: "Find Shopify customers by email.",
  inputSchema: z.object({
    auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
    email: z.string().email(),
    limit: z.number().min(1).max(50).default(5),
  }),
  outputSchema: z.object({ customers: z.array(z.unknown()).default([]) }),
  execute: async ({ context }: { context: any }) => {
    const cid = randomUUID();
    logToolStart("shopifyGetCustomerByEmail", cid, redactAuth(context));
    const { auth, email, limit } = context as any;
    if (!isValidShopDomain(auth.shop)) return { customers: [] };
    const baseUrl = shopifyApiBase(auth.shop);
    const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
    const res = await fetchWithRetry(`${baseUrl}/customers/search.json?query=${encodeURIComponent(`email:${email}`)}&limit=${limit}`, { headers: { ...headers }, correlationId: cid });
    if (!res.ok) return { customers: [] };
    const data = await safeJson(res);
    const out = { customers: Array.isArray((data as any)?.customers) ? (data as any).customers : [] };
    logToolEnd("shopifyGetCustomerByEmail", cid, true, out);
    return out;
  },
});

export const shopifyCancelOrder = createTool({
  id: "shopifyCancelOrder",
  description: "Cancel a Shopify order by id.",
  inputSchema: z.object({
    auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
    orderId: z.union([z.string(), z.number()]),
  }),
  outputSchema: z.object({ ok: z.boolean(), message: z.string().optional() }),
  execute: async ({ context }: { context: any }) => {
    const cid = randomUUID();
    logToolStart("shopifyCancelOrder", cid, redactAuth(context));
    const { auth, orderId } = context as any;
    const res = await runShopifyAction({ actionType: "cancel_order", payload: { order_id: orderId }, auth });
    const message = (res as any).message;
    const out = { ok: res.ok, message } as { ok: boolean; message?: string };
    logToolEnd("shopifyCancelOrder", cid, out.ok, out);
    return out;
  },
});

export const shopifyUpdateAddress = createTool({
  id: "shopifyUpdateAddress",
  description: "Update an order's shipping address.",
  inputSchema: z.object({
    auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
    orderId: z.union([z.string(), z.number()]),
    shippingAddress: z.record(z.string(), z.unknown()),
  }),
  outputSchema: z.object({ ok: z.boolean(), message: z.string().optional() }),
  execute: async ({ context }: { context: any }) => {
    const cid = randomUUID();
    logToolStart("shopifyUpdateAddress", cid, redactAuth(context));
    const { auth, orderId, shippingAddress } = context as any;
    const res = await runShopifyAction({ actionType: "update_address", payload: { order_id: orderId, shipping_address: shippingAddress }, auth });
    const message = (res as any).message;
    const out = { ok: res.ok, message } as { ok: boolean; message?: string };
    logToolEnd("shopifyUpdateAddress", cid, out.ok, out);
    return out;
  },
});

export const shopifyCreateReplacementDraftOrder = createTool({
  id: "shopifyCreateReplacementDraftOrder",
  description: "Create a draft order as a free replacement for an existing order.",
  inputSchema: z.object({
    auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
    orderId: z.union([z.string(), z.number()]),
    note: z.string().default("Replacement order at no charge"),
  }),
  outputSchema: z.object({ ok: z.boolean(), draftOrderId: z.union([z.string(), z.number()]).optional(), message: z.string().optional() }),
  execute: async ({ context }: { context: any }) => {
    const cid = randomUUID();
    logToolStart("shopifyCreateReplacementDraftOrder", cid, redactAuth(context));
    const { auth, orderId, note } = context as any;
    if (!isValidShopDomain(auth.shop)) return { ok: false, message: "Invalid shop domain" };
    const baseUrl = shopifyApiBase(auth.shop);
    const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
    const orderRes = await fetchWithRetry(`${baseUrl}/orders/${orderId}.json`, { headers: { ...headers }, correlationId: cid });
    if (!orderRes.ok) return { ok: false, message: "Order not found" };
    const order = (await safeJson(orderRes) as any)?.order;
    if (!order) return { ok: false, message: "Order not found" };
    const draftBody = buildReplacementDraftBody(order, note);
    const res = await fetchWithRetry(`${baseUrl}/draft_orders.json`, { method: "POST", headers: { ...headers }, body: JSON.stringify(draftBody), correlationId: cid });
    if (!res.ok) return { ok: false, message: "Draft order creation failed" };
    const data = await safeJson(res);
    const draftOrderId = (data as any)?.draft_order?.id;
    const out = { ok: true, draftOrderId } as { ok: boolean; draftOrderId?: string | number };
    logToolEnd("shopifyCreateReplacementDraftOrder", cid, out.ok, out);
    return out;
  },
});

export const shopifyAddOrderNote = createTool({
  id: "shopifyAddOrderNote",
  description: "Add or update the note on a Shopify order.",
  inputSchema: z.object({
    auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
    orderId: z.union([z.string(), z.number()]),
    note: z.string().min(1),
  }),
  outputSchema: z.object({ ok: z.boolean(), message: z.string().optional() }),
  execute: async ({ context }: { context: any }) => {
    const cid = randomUUID();
    logToolStart("shopifyAddOrderNote", cid, redactAuth(context));
    const { auth, orderId, note } = context as any;
    if (!isValidShopDomain(auth.shop)) return { ok: false, message: "Invalid shop domain" };
    const baseUrl = shopifyApiBase(auth.shop);
    const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
    const body = JSON.stringify({ order: { id: orderId, note } });
    const res = await fetchWithRetry(`${baseUrl}/orders/${orderId}.json`, { method: "PUT", headers: { ...headers }, body, correlationId: cid });
    if (!res.ok) return { ok: false, message: "Failed to update note" };
    const out = { ok: true, message: "Order note updated" };
    logToolEnd("shopifyAddOrderNote", cid, true, out);
    return out;
  },
});

export const shopifyGetOrderStatus = createTool({
  id: "shopifyGetOrderStatus",
  description: "Get fulfillment and financial status for an order.",
  inputSchema: z.object({
    auth: z.object({ shop: z.string().min(1), accessToken: z.string().min(1) }),
    orderId: z.union([z.string(), z.number()]),
  }),
  outputSchema: z.object({ status: z.record(z.string(), z.unknown()).optional() }),
  execute: async ({ context }: { context: any }) => {
    const cid = randomUUID();
    logToolStart("shopifyGetOrderStatus", cid, redactAuth(context));
    const { auth, orderId } = context as any;
    if (!isValidShopDomain(auth.shop)) return { status: undefined };
    const baseUrl = shopifyApiBase(auth.shop);
    const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.accessToken } as const;
    const res = await fetchWithRetry(`${baseUrl}/orders/${orderId}.json`, { headers: { ...headers }, correlationId: cid });
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
    const out = { status };
    logToolEnd("shopifyGetOrderStatus", cid, true, out);
    return out;
  },
});

export const shopifyAction = createTool({
  id: "shopifyAction",
  description: "Execute a Shopify customer support action. Provide 'auth' with shop and accessToken.",
  inputSchema: z.object({
    actionType: z.enum(["cancel_order", "update_address", "resend_order"] as const),
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
  execute: async ({ context }: { context: any }) => {
    const cid = randomUUID();
    logToolStart("shopifyAction", cid, redactAuth(context));
    const { actionType, payload, auth } = context as {
      actionType: "cancel_order" | "update_address" | "resend_order";
      payload: Record<string, unknown>;
      auth: { shop: string; accessToken: string };
    };
    const result = await runShopifyAction({ actionType, payload, auth });
    const out = { ok: result.ok, message: (result as any).message } as { ok: boolean; message?: string };
    logToolEnd("shopifyAction", cid, out.ok, out);
    return out;
  },
});
