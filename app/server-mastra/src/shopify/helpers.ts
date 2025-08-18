import { safeJson, toObj } from "../utils/http.js";
import type { AllowedAction } from "./constants.js";

export type ShopifyAuth = { shop: string; accessToken: string };

export function shopifyApiBase(shop: string, version = "2024-10") {
  return `https://${shop}/admin/api/${version}`;
}

// Helper to build a free replacement draft order body (handles variant/custom items)
export function buildReplacementDraftBody(order: any, note: string) {
  const line_items = (order.line_items || []).map((li: any) => {
    const hasVariant = Boolean(li.variant_id);
    if (hasVariant) {
      return {
        variant_id: li.variant_id,
        quantity: li.quantity || 1,
        applied_discount: { value_type: "percentage", value: "100.0" },
        title: li.title,
      };
    }
    return {
      title: li.title || "Replacement Item",
      quantity: li.quantity || 1,
      price: String(li.price ?? "0.0"),
      applied_discount: { value_type: "percentage", value: "100.0" },
    };
  });
  return {
    draft_order: {
      line_items,
      shipping_address: order.shipping_address,
      billing_address: order.billing_address,
      customer: order.customer ? { id: order.customer.id } : undefined,
      note,
      use_customer_default_address: true,
    },
  } as const;
}

export async function runShopifyAction(params: {
  actionType: AllowedAction;
  payload: Record<string, unknown>;
  auth: ShopifyAuth;
}): Promise<
  | { ok: true; message?: string; data?: Record<string, unknown> }
  | { ok: false; reason: string; message?: string; details?: Record<string, unknown> }
> {
  const baseUrl = shopifyApiBase(params.auth.shop);
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": params.auth.accessToken,
  } as const;

  try {
    switch (params.actionType) {
      case "cancel_order": {
        const orderId = params.payload["order_id"] as string | number | undefined;
        if (!orderId) return { ok: false, reason: "Missing order_id", message: "Missing order_id" };
        const res = await fetch(`${baseUrl}/orders/${orderId}/cancel.json`, {
          method: "POST",
          headers,
        });
        if (!res.ok) return { ok: false, reason: "Shopify cancel failed", message: "Shopify cancel failed", details: toObj(await safeJson(res)) };
        return { ok: true, message: "Order cancelled", data: toObj(await safeJson(res)) };
      }
      case "update_address": {
        const orderId = params.payload["order_id"] as string | number | undefined;
        const address = params.payload["shipping_address"] as Record<string, unknown> | undefined;
        if (!orderId || !address) return { ok: false, reason: "Missing order_id or shipping_address", message: "Missing order_id or shipping_address" };
        const body = JSON.stringify({ order: { id: orderId, shipping_address: address } });
        const res = await fetch(`${baseUrl}/orders/${orderId}.json`, {
          method: "PUT",
          headers,
          body,
        });
        if (!res.ok) return { ok: false, reason: "Shopify address update failed", message: "Shopify address update failed", details: toObj(await safeJson(res)) };
        return { ok: true, message: "Shipping address updated", data: toObj(await safeJson(res)) };
      }
      case "resend_order": {
        const orderId = params.payload["order_id"] as string | number | undefined;
        const note = (params.payload["note"] as string | undefined) || "Replacement order at no charge";
        const sendInvoice = Boolean(params.payload["send_invoice"]);
        const invoiceTo = params.payload["invoice_to"] as string | undefined;
        if (!orderId) return { ok: false, reason: "Missing order_id", message: "Missing order_id" };

        // Load original order
        const orderRes = await fetch(`${baseUrl}/orders/${orderId}.json`, { headers });
        if (!orderRes.ok) return { ok: false, reason: "Order not found", message: "Order not found", details: toObj(await safeJson(orderRes)) };
        const order = (await safeJson(orderRes) as any)?.order;
        if (!order) return { ok: false, reason: "Order not found", message: "Order not found" };

        // Build free replacement draft order
        const draftBody = buildReplacementDraftBody(order, note);
        const draftRes = await fetch(`${baseUrl}/draft_orders.json`, { method: "POST", headers, body: JSON.stringify(draftBody) });
        if (!draftRes.ok) return { ok: false, reason: "Draft order creation failed", message: "Draft order creation failed", details: toObj(await safeJson(draftRes)) };
        const draftData = await safeJson(draftRes);
        const draftOrderId = (draftData as any)?.draft_order?.id;

        // Optionally send invoice
        if (sendInvoice && draftOrderId) {
          const invoiceBody = JSON.stringify({ draft_order_invoice: invoiceTo ? { to: invoiceTo } : {} });
          const invRes = await fetch(`${baseUrl}/draft_orders/${draftOrderId}/send_invoice.json`, { method: "POST", headers, body: invoiceBody });
          if (!invRes.ok) {
            return { ok: true, message: "Replacement draft created; invoice failed to send", data: { draftOrderId } as Record<string, unknown> };
          }
        }

        return { ok: true, message: "Replacement draft created", data: { draftOrderId } as Record<string, unknown> };
      }
      default:
        return { ok: false, reason: "Unsupported actionType" };
    }
  } catch (e) {
    return { ok: false, reason: "Exception during Shopify call", message: "Exception during Shopify call", details: { error: String(e) } as Record<string, unknown> };
  }
}
