import { z } from "zod";

export type RechargeAuth = { apiKey?: string; base?: string; version?: string };
export type RechargeAuthContext = { auth?: RechargeAuth } | undefined;

export function resolveRechargeVersion(auth?: RechargeAuth): string {
  const raw = auth?.version ?? process.env.RECHARGE_API_VERSION ?? "default";
  const v = String(raw).trim();
  const lower = v.toLowerCase();
  const aliasEnv =
    lower === "newest" || lower === "latest"
      ? process.env.RECHARGE_API_VERSION_NEWEST
      : lower === "second-newest"
      ? process.env.RECHARGE_API_VERSION_SECOND_NEWEST
      : undefined;
  const resolved = (aliasEnv && String(aliasEnv).trim()) || v;
  return resolved;
}

export function getRechargeConfig(ctx: RechargeAuthContext) {
  const apiKey = (ctx?.auth?.apiKey as string | undefined) || process.env.RECHARGE_API_KEY;
  const base = (ctx?.auth?.base as string | undefined) || process.env.RECHARGE_API_BASE || "https://api.rechargeapps.com";
  if (!apiKey) {
    return { ok: false as const, code: "MissingRechargeApiKey", message: "Recharge API key not provided" };
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Recharge-Access-Token": apiKey,
  };
  const resolvedVersion = resolveRechargeVersion(ctx?.auth);
  if (resolvedVersion && resolvedVersion !== "default") {
    headers["X-Recharge-Version"] = resolvedVersion;
  }
  return { ok: true as const, base, headers };
}

export const UPDATE_FIELD_KEYS = [
  "orderIntervalUnit",
  "orderIntervalFrequency",
  "chargeIntervalFrequency",
  "quantity",
  "price",
  "planId",
  "orderDayOfMonth",
  "orderDayOfWeek",
  "externalVariantId",
  "useExternalVariantDefaults",
  "sku",
  "skuOverride",
  "variantTitle",
  "properties",
  "nextChargeScheduledAt",
] as const;

export const VERSIONED_UPDATE_ALLOWED_FIELDS = {
  default: new Set(UPDATE_FIELD_KEYS),
  newest: new Set(UPDATE_FIELD_KEYS),
  latest: new Set(UPDATE_FIELD_KEYS),
  "second-newest": new Set(UPDATE_FIELD_KEYS),
  "2021-11": new Set(UPDATE_FIELD_KEYS),
} as const satisfies Record<string, ReadonlySet<(typeof UPDATE_FIELD_KEYS)[number]>>;

export function allowedUpdateFieldsFor(auth?: RechargeAuth): ReadonlySet<(typeof UPDATE_FIELD_KEYS)[number]> {
  const ver = resolveRechargeVersion(auth);
  if (Object.prototype.hasOwnProperty.call(VERSIONED_UPDATE_ALLOWED_FIELDS, ver)) {
    return VERSIONED_UPDATE_ALLOWED_FIELDS[ver as keyof typeof VERSIONED_UPDATE_ALLOWED_FIELDS];
  }
  return VERSIONED_UPDATE_ALLOWED_FIELDS.default;
}

