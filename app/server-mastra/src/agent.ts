import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
// Minimal server-only agent surface, now using Mastra for LLM-driven extraction.
// Keep this file free of client-side imports. Do not import app code from here.
import { Agent } from "@mastra/core";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import * as ShopifyTools from "./shopify/tools.js";
import * as RechargeTools from "./recharge/tools.js";
import { ALLOWED_ACTIONS, AllowedAction } from "./shopify/constants.js";
import { runShopifyAction as runShopifyActionHelper, type ShopifyAuth } from "./shopify/helpers.js";
import type { Result } from "./types/envelope.js";

const allowedActionsText = ALLOWED_ACTIONS.join(", ");

export type ProposedAction = {
  id: string;
  actionType: AllowedAction;
  payload: Record<string, unknown>;
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

// (all Recharge helpers and inline tools removed; now using RechargeTools.*)

export async function proposeFromEmail(
  content: string,
  _opts?: { llm?: LlmOptions },
): Promise<ProposedAction[]> {
  // Define structured output schema for actions
  const ActionsSchema = z.object({
    actions: z
      .array(
        z.object({
          actionType: z.enum(ALLOWED_ACTIONS),
          payload: z.record(z.string(), z.unknown()).default({}),
          summary: z.string().min(1),
        }),
      )
      .default([]),
  });

  // (inline Shopify tools removed; using modularized tools via ShopifyTools.*)

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
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const memoryUrl = process.env.MASTRA_MEMORY_URL || `file:${resolve(__dirname, "../memory.db")}`;
  const memory = new Memory({
    storage: new LibSQLStore({ url: memoryUrl }),
  });

  // (inline shopifyAction tool removed; using ShopifyTools.shopifyAction)

  const agent = new Agent({
    name: "email-support-agent",
    instructions:
      "You are a Shopify customer support action extractor. Read the email and output actions only.",
    model,
    memory,
    tools: {
      shopifyAction: ShopifyTools.shopifyAction,
      shopifyGetOrder: ShopifyTools.shopifyGetOrder,
      shopifyGetCustomerByEmail: ShopifyTools.shopifyGetCustomerByEmail,
      shopifyCancelOrder: ShopifyTools.shopifyCancelOrder,
      shopifyUpdateAddress: ShopifyTools.shopifyUpdateAddress,
      shopifyCreateReplacementDraftOrder: ShopifyTools.shopifyCreateReplacementDraftOrder,
      shopifyAddOrderNote: ShopifyTools.shopifyAddOrderNote,
      shopifyGetOrderStatus: ShopifyTools.shopifyGetOrderStatus,
      shopifyGetFulfillments: ShopifyTools.shopifyGetFulfillments,
      shopifySendDraftInvoice: ShopifyTools.shopifySendDraftInvoice,
      shopifyListOrdersForCustomer: ShopifyTools.shopifyListOrdersForCustomer,
      shopifyCalculateRefund: ShopifyTools.shopifyCalculateRefund,
      shopifyCreateRefund: ShopifyTools.shopifyCreateRefund,
      rechargeGetCustomerByEmail: RechargeTools.rechargeGetCustomerByEmail,
      rechargeListSubscriptions: RechargeTools.rechargeListSubscriptions,
      rechargeCancelSubscription: RechargeTools.rechargeCancelSubscription,
      rechargeUpdateSubscription: RechargeTools.rechargeUpdateSubscription,
      rechargeSetNextChargeDate: RechargeTools.rechargeSetNextChargeDate,
    },
  });

  try {
    const messages = [
      {
        role: "system" as const,
        content:
          `Return JSON that strictly matches the output schema. Allowed actionType values: ${allowedActionsText}. Put details in payload. No extra prose.`,
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
    type ActionOut = { actionType: AllowedAction; payload?: Record<string, unknown>; summary: string };
    const raw = (output?.actions ?? []) as ActionOut[];
    const actions: ProposedAction[] = raw.map((a) => ({
      id: randomUUID(),
      actionType: a.actionType,
      payload: (a.payload ?? {}) as Record<string, unknown>,
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

// Thin executor export used by `app/src/lib/agent/bridge.ts#runShopifyActionBridge`
export async function runShopifyAction(params: {
  actionType: AllowedAction;
  payload: Record<string, unknown>;
  auth: ShopifyAuth;
  correlationId?: string;
}): Promise<Result<Record<string, unknown>>> {
  return runShopifyActionHelper(params);
}
