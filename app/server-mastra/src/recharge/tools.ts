import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { safeJson } from "../utils/http.js";
import {
  getRechargeConfig,
  resolveRechargeVersion,
  allowedUpdateFieldsFor,
  VERSIONED_UPDATE_ALLOWED_FIELDS,
  UPDATE_FIELD_KEYS,
  type RechargeAuth,
} from "./config.js";

export const rechargeGetCustomerByEmail = createTool({
  id: "rechargeGetCustomerByEmail",
  description: "Find Recharge customer by email.",
  inputSchema: z.object({
    auth: z
      .object({ apiKey: z.string().min(1).optional(), base: z.string().optional(), version: z.string().optional() })
      .default({}),
    email: z.string().email(),
    limit: z.number().min(1).max(50).default(5),
  }),
  outputSchema: z.object({ customers: z.array(z.unknown()).default([]) }),
  execute: async ({ context }: { context: any }) => {
    const cfg = getRechargeConfig(context);
    if (!cfg.ok) return { customers: [] };
    const { base, headers } = cfg;
    const url = `${base}/customers?email=${encodeURIComponent(context.email)}&limit=${context.limit}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return { customers: [] };
    const data = await safeJson(res);
    const customers = (data as any)?.customers;
    return { customers: Array.isArray(customers) ? customers : [] };
  },
});

export const rechargeListSubscriptions = createTool({
  id: "rechargeListSubscriptions",
  description: "List Recharge subscriptions by email or customerId.",
  inputSchema: z
    .object({
      auth: z
        .object({ apiKey: z.string().min(1).optional(), base: z.string().optional(), version: z.string().optional() })
        .default({}),
      customerId: z.union([z.string(), z.number()]).optional(),
      email: z.string().email().optional(),
      status: z.string().default("active"),
      limit: z.number().min(1).max(100).default(50),
    })
    .refine((v) => Boolean(v.customerId || v.email), { message: "Provide customerId or email" }),
  outputSchema: z.object({ subscriptions: z.array(z.unknown()).default([]) }),
  execute: async ({ context }: { context: any }) => {
    const cfg = getRechargeConfig(context);
    if (!cfg.ok) return { subscriptions: [] };
    const { base, headers } = cfg;

    let customerId = context.customerId;
    if (!customerId && context.email) {
      const cres = await fetch(`${base}/customers?email=${encodeURIComponent(context.email)}&limit=1`, { headers });
      if (!cres.ok) return { subscriptions: [] };
      const cdata = await safeJson(cres);
      customerId = (Array.isArray((cdata as any)?.customers) && (cdata as any).customers[0]?.id) || undefined;
      if (!customerId) return { subscriptions: [] };
    }

    const url = `${base}/subscriptions?customer_id=${customerId}&status=${encodeURIComponent(context.status)}&limit=${context.limit}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return { subscriptions: [] };
    const data = await safeJson(res);
    const subs = (data as any)?.subscriptions;
    return { subscriptions: Array.isArray(subs) ? subs : [] };
  },
});

export const rechargeCancelSubscription = createTool({
  id: "rechargeCancelSubscription",
  description: "Cancel a Recharge subscription (requires cancellation_reason).",
  inputSchema: z.object({
    auth: z
      .object({ apiKey: z.string().min(1).optional(), base: z.string().optional(), version: z.string().optional() })
      .default({}),
    subscriptionId: z.union([z.string(), z.number()]),
    reason: z.string().min(1),
    reasonComments: z.string().max(1024).optional(),
    sendEmail: z.boolean().default(true),
  }),
  outputSchema: z.object({ ok: z.boolean(), message: z.string().optional(), data: z.unknown().optional() }),
  execute: async ({ context }: { context: any }) => {
    const cfg = getRechargeConfig(context);
    if (!cfg.ok) return { ok: false, message: "Recharge API key not configured" };
    const { base, headers } = cfg;

    const body: Record<string, unknown> = {
      cancellation_reason: context.reason.trim(),
    };
    if (typeof context.reasonComments === "string" && context.reasonComments.trim()) {
      body["cancellation_reason_comments"] = context.reasonComments.trim();
    }
    if (typeof context.sendEmail === "boolean") {
      body["send_email"] = context.sendEmail;
    }

    const res = await fetch(`${base}/subscriptions/${context.subscriptionId}/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, message: "Cancel failed", data: await safeJson(res) };
    return { ok: true, message: "Subscription cancelled", data: await safeJson(res) };
  },
});

export const rechargeUpdateSubscription = createTool({
  id: "rechargeUpdateSubscription",
  description: "Update Recharge subscription fields (interval unit/frequency, quantity, price, plan, etc).",
  inputSchema: z
    .object({
      auth: z
        .object({ apiKey: z.string().min(1).optional(), base: z.string().optional(), version: z.string().optional() })
        .default({}),
      subscriptionId: z.union([z.string(), z.number()]),
      orderIntervalUnit: z.enum(["day", "week", "month"]).optional(),
      orderIntervalFrequency: z.number().int().positive().optional(),
      chargeIntervalFrequency: z.number().int().positive().optional(),
      quantity: z.number().int().positive().optional(),
      price: z.union([z.string(), z.number()]).optional(),
      planId: z.number().int().optional(),
      orderDayOfMonth: z.string().optional(),
      orderDayOfWeek: z.string().optional(),
      externalVariantId: z.union([z.string(), z.number()]).optional(),
      useExternalVariantDefaults: z.boolean().optional(),
      sku: z.string().optional(),
      skuOverride: z.boolean().optional(),
      variantTitle: z.string().optional(),
      properties: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
      nextChargeScheduledAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/i, "Must be YYYY-MM-DD").optional(),
      commit: z.boolean().optional(),
      forceUpdate: z.boolean().optional(),
    })
    .strict()
    .refine(
      (v) => (v.orderIntervalUnit ? v.orderIntervalFrequency != null && v.chargeIntervalFrequency != null : true),
      { message: "orderIntervalFrequency and chargeIntervalFrequency are required when orderIntervalUnit is provided" },
    )
    .refine((v) => (v.price !== undefined ? Number.isFinite(Number(v.price)) && Number(v.price) >= 0 : true), { message: "price must be a non-negative number" })
    .refine((v) => (v.orderDayOfWeek !== undefined ? v.orderIntervalUnit === "week" : true), { message: "orderDayOfWeek is only valid when orderIntervalUnit is 'week'" })
    .refine((v) => (v.orderDayOfMonth !== undefined ? v.orderIntervalUnit === "month" : true), { message: "orderDayOfMonth is only valid when orderIntervalUnit is 'month'" })
    .refine((v) => {
      const candidates = [
        v.orderIntervalUnit,
        v.orderIntervalFrequency,
        v.chargeIntervalFrequency,
        v.quantity,
        v.price,
        v.planId,
        v.orderDayOfMonth,
        v.orderDayOfWeek,
        v.externalVariantId,
        v.useExternalVariantDefaults,
        v.sku,
        v.skuOverride,
        v.variantTitle,
        v.properties && v.properties.length > 0 ? v.properties : undefined,
        v.nextChargeScheduledAt,
      ];
      return candidates.some((c) => c !== undefined && c !== null);
    }, { message: "At least one field must be provided to update the subscription" })
    .superRefine((v: unknown, ctx: z.RefinementCtx) => {
      type UpdatableKeys = (typeof UPDATE_FIELD_KEYS)[number];
      type VersionAuth = { auth?: { version?: string } };
      type Narrow = VersionAuth & Partial<Record<UpdatableKeys, unknown>>;
      const vv = v as Narrow;
      const allowed = allowedUpdateFieldsFor(vv.auth as RechargeAuth);
      const resolved = resolveRechargeVersion(vv.auth as RechargeAuth);
      const known = Object.prototype.hasOwnProperty.call(VERSIONED_UPDATE_ALLOWED_FIELDS, resolved) || resolved === "default";
      if (!known) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["auth", "version"],
          message: `Unknown Recharge API version "${resolved}". Define RECHARGE_API_VERSION_NEWEST/RECHARGE_API_VERSION_SECOND_NEWEST or use a concrete version like "2021-11".`,
        });
      }
      for (const key of UPDATE_FIELD_KEYS) {
        if ((vv as any)[key] !== undefined && !allowed.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key as string],
            message: `Field not supported for Recharge API version "${resolveRechargeVersion(vv.auth as RechargeAuth)}". Allowed: ${Array.from(allowed).join(", ")}`,
          });
        }
      }
    }),
  outputSchema: z.object({ ok: z.boolean(), message: z.string().optional(), subscription: z.unknown().optional(), data: z.unknown().optional() }),
  execute: async ({ context }: { context: any }) => {
    const cfg = getRechargeConfig(context);
    if (!cfg.ok) return { ok: false, message: "Recharge API key not configured" };
    const { base, headers } = cfg;

    const resolvedVersion = resolveRechargeVersion(context?.auth);
    const knownProfile = Object.prototype.hasOwnProperty.call(VERSIONED_UPDATE_ALLOWED_FIELDS, resolvedVersion);

    const body: Record<string, unknown> = {};
    if (context.orderIntervalUnit) body["order_interval_unit"] = context.orderIntervalUnit;
    if (context.orderIntervalFrequency != null) body["order_interval_frequency"] = context.orderIntervalFrequency;
    if (context.chargeIntervalFrequency != null) body["charge_interval_frequency"] = context.chargeIntervalFrequency;
    if (context.quantity != null) body["quantity"] = context.quantity;
    if (typeof context.price === "string" || typeof context.price === "number") body["price"] = String(context.price);
    if (context.planId != null) body["plan_id"] = context.planId;
    if (typeof context.orderDayOfMonth === "string") body["order_day_of_month"] = context.orderDayOfMonth.trim();
    if (typeof context.orderDayOfWeek === "string") body["order_day_of_week"] = context.orderDayOfWeek.trim();
    if (context.externalVariantId != null) body["external_variant_id"] = context.externalVariantId;
    if (typeof context.useExternalVariantDefaults === "boolean") body["use_external_variant_defaults"] = context.useExternalVariantDefaults;
    if (typeof context.sku === "string") body["sku"] = context.sku.trim();
    if (typeof context.skuOverride === "boolean") body["sku_override"] = context.skuOverride;
    if (typeof context.variantTitle === "string") body["variant_title"] = context.variantTitle.trim();
    if (Array.isArray(context.properties)) {
      body["properties"] = context.properties.map((p: any) => ({ name: String(p?.name ?? "").trim(), value: String(p?.value ?? "").trim() }));
    }
    if (typeof context.nextChargeScheduledAt === "string") body["next_charge_scheduled_at"] = context.nextChargeScheduledAt.trim();

    const params = new URLSearchParams();
    if (typeof context.commit === "boolean") params.set("commit", String(context.commit));
    if (typeof context.forceUpdate === "boolean") params.set("force_update", String(context.forceUpdate));
    const qs = params.toString();

    if (Object.keys(body).length === 0) {
      return { ok: false, message: "No fields provided to update" };
    }
    const res = await fetch(`${base}/subscriptions/${context.subscriptionId}${qs ? `?${qs}` : ""}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, message: "Update failed", data: await safeJson(res) };
    const data = await safeJson(res);
    const msg = `Subscription updated${knownProfile ? "" : ` (unknown version '${resolvedVersion}', used default profile)`}`;
    return { ok: true, message: msg, subscription: (data as any)?.subscription, data };
  },
});

export const rechargeSetNextChargeDate = createTool({
  id: "rechargeSetNextChargeDate",
  description: "Set the next charge date for a Recharge subscription (YYYY-MM-DD).",
  inputSchema: z.object({
    auth: z
      .object({ apiKey: z.string().min(1).optional(), base: z.string().optional(), version: z.string().optional() })
      .default({}),
    subscriptionId: z.union([z.string(), z.number()]),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/i, "Must be YYYY-MM-DD"),
  }),
  outputSchema: z.object({ ok: z.boolean(), message: z.string().optional(), subscription: z.unknown().optional(), data: z.unknown().optional() }),
  execute: async ({ context }: { context: any }) => {
    const cfg = getRechargeConfig(context);
    if (!cfg.ok) return { ok: false, message: "Recharge API key not configured" };
    const { base, headers } = cfg;

    const res = await fetch(`${base}/subscriptions/${context.subscriptionId}/set_next_charge_date`, {
      method: "POST",
      headers,
      body: JSON.stringify({ date: context.date }),
    });
    if (!res.ok) return { ok: false, message: "Set next charge date failed", data: await safeJson(res) };
    const data = await safeJson(res);
    return { ok: true, message: "Next charge date set", subscription: (data as any)?.subscription, data };
  },
});
