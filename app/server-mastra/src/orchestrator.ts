import { proposeFromEmail, runShopifyAction, type LlmOptions, type ProposedAction } from "./agent.js";
import { randomUUID } from "node:crypto";
import type { ShopifyAuth } from "./shopify/helpers.js";
import type { Reporter, ExecutionRecord } from "./reporter.js";
import { defaultReporter } from "./reporter.js";

export type OrchestrateEmailParams = {
  content: string;
  llm?: LlmOptions;
  // When true, execute supported actions (currently Shopify-only) using provided auth
  execute?: boolean;
  shopifyAuth?: ShopifyAuth;
  reporter?: Reporter;
};

export type OrchestrateEmailResult = {
  proposed: ProposedAction[];
  executed?: Array<{
    id: string;
    actionType: ProposedAction["actionType"];
    ok: boolean;
    message?: string;
    code?: string;
    data?: Record<string, unknown>;
  }>;
};

export async function orchestrateEmail(params: OrchestrateEmailParams): Promise<OrchestrateEmailResult> {
  const reporter = params.reporter ?? defaultReporter;
  const correlationId = randomUUID();
  const proposed = await proposeFromEmail(params.content, params.llm ? { llm: params.llm } : undefined);
  try {
    await reporter.onProposed?.(proposed);
  } catch {
    // non-fatal
  }

  if (!params.execute) {
    return { proposed };
  }

  // Execute supported Shopify actions if auth is provided
  const executed: ExecutionRecord[] = [];
  for (const action of proposed) {
    // Currently all AllowedAction values are Shopify actions
    if (!params.shopifyAuth) {
      executed.push({ id: action.id, actionType: action.actionType, ok: false, code: "MissingShopifyAuth", message: "Missing Shopify auth" });
      continue;
    }
    try {
      const res = await runShopifyAction({ actionType: action.actionType, payload: action.payload, auth: params.shopifyAuth, correlationId });
      if (res.ok) {
        executed.push({ id: action.id, actionType: action.actionType, ok: true, message: res.message, data: (res as any).data });
      } else {
        executed.push({ id: action.id, actionType: action.actionType, ok: false, code: (res as any).code, message: res.message, data: (res as any).data });
      }
    } catch (e) {
      executed.push({ id: action.id, actionType: action.actionType, ok: false, code: "ExecutionFailed", message: (e as Error)?.message || "Execution failed" });
    }
  }
  try {
    await reporter.onExecuted?.(executed);
  } catch {
    // non-fatal
  }
  return { proposed, executed };
}
