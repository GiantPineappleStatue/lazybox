import { safeJson, toObj, fetchWithRetry } from "../utils/http.js";
import type { AllowedAction } from "./constants.js";
import type { Result } from "../types/envelope.js";

export type ShopifyAuth = { shop: string; accessToken: string };

export function isValidShopDomain(shop: string): boolean {
  // Basic allowlist for myshopify domains. Adjust if using custom domains.
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/i.test(shop);
}

export function shopifyApiBase(shop: string, version = "2024-10") {
  const apiVersion = process.env.SHOPIFY_API_VERSION || version;
  return `https://${shop}/admin/api/${apiVersion}`;
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
  correlationId?: string;
}): Promise<Result<Record<string, unknown>>> {
  if (!isValidShopDomain(params.auth.shop)) {
    return { ok: false, code: "InvalidShopDomain", message: "Invalid Shopify shop domain" };
  }
  const baseUrl = shopifyApiBase(params.auth.shop);
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": params.auth.accessToken,
  } as const;

  try {
    switch (params.actionType) {
      case "cancel_order": {
        const raw = params.payload["order_id"] as string | number | undefined;
        const orderId = Number(raw);
        if (!Number.isFinite(orderId) || orderId <= 0) return { ok: false, code: "InvalidInput", message: "Invalid order_id" };
        const res = await fetchWithRetry(`${baseUrl}/orders/${orderId}/cancel.json`, {
          method: "POST",
          headers: { ...headers },
          correlationId: params.correlationId,
        });
        if (!res.ok) return { ok: false, code: "ShopifyCancelFailed", message: "Shopify cancel failed", data: toObj(await safeJson(res)) };
        return { ok: true, message: "Order cancelled", data: toObj(await safeJson(res)) };
      }
      case "update_address": {
        const raw = params.payload["order_id"] as string | number | undefined;
        const orderId = Number(raw);
        const address = params.payload["shipping_address"] as Record<string, unknown> | undefined;
        if (!Number.isFinite(orderId) || orderId <= 0 || !address) return { ok: false, code: "InvalidInput", message: "Missing order_id or shipping_address" };
        const body = JSON.stringify({ order: { id: orderId, shipping_address: address } });
        const res = await fetchWithRetry(`${baseUrl}/orders/${orderId}.json`, {
          method: "PUT",
          headers: { ...headers },
          body,
          correlationId: params.correlationId,
        });
        if (!res.ok) return { ok: false, code: "ShopifyAddressUpdateFailed", message: "Shopify address update failed", data: toObj(await safeJson(res)) };
        return { ok: true, message: "Shipping address updated", data: toObj(await safeJson(res)) };
      }
      case "resend_order": {
        const raw = params.payload["order_id"] as string | number | undefined;
        const orderId = Number(raw);
        const note = (params.payload["note"] as string | undefined) || "Replacement order at no charge";
        const sendInvoice = Boolean(params.payload["send_invoice"]);
        const invoiceTo = params.payload["invoice_to"] as string | undefined;
        if (!Number.isFinite(orderId) || orderId <= 0) return { ok: false, code: "InvalidInput", message: "Invalid order_id" };

        // Load original order
        const orderRes = await fetchWithRetry(`${baseUrl}/orders/${orderId}.json`, { headers: { ...headers }, correlationId: params.correlationId });
        if (!orderRes.ok) return { ok: false, code: "NotFound", message: "Order not found", data: toObj(await safeJson(orderRes)) };
        const order = (await safeJson(orderRes) as any)?.order;
        if (!order) return { ok: false, code: "NotFound", message: "Order not found" };

        // Build free replacement draft order
        const draftBody = buildReplacementDraftBody(order, note);
        const draftRes = await fetchWithRetry(`${baseUrl}/draft_orders.json`, { method: "POST", headers: { ...headers }, body: JSON.stringify(draftBody), correlationId: params.correlationId });
        if (!draftRes.ok) return { ok: false, code: "DraftCreationFailed", message: "Draft order creation failed", data: toObj(await safeJson(draftRes)) };
        const draftData = await safeJson(draftRes);
        const draftOrderId = (draftData as any)?.draft_order?.id;

        // Optionally send invoice
        if (sendInvoice && draftOrderId) {
          const invoiceBody = JSON.stringify({ draft_order_invoice: invoiceTo ? { to: invoiceTo } : {} });
          const invRes = await fetchWithRetry(`${baseUrl}/draft_orders/${draftOrderId}/send_invoice.json`, { method: "POST", headers: { ...headers }, body: invoiceBody, correlationId: params.correlationId });
          if (!invRes.ok) {
            return { ok: true, message: "Replacement draft created; invoice failed to send", data: { draftOrderId } as Record<string, unknown> };
          }
        }

        return { ok: true, message: "Replacement draft created", data: { draftOrderId } as Record<string, unknown> };
      }
      default:
        return { ok: false, code: "UnsupportedAction", message: "Unsupported actionType" };
    }
  } catch (e) {
    return { ok: false, code: "Exception", message: "Exception during Shopify call", data: { error: String(e) } as Record<string, unknown> };
  }
}
