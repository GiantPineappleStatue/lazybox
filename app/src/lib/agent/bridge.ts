import { serverOnly } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { db } from "~/lib/db";
import { decrypt } from "~/lib/crypto/secureStore";
import { env } from "~/env/server";

export type ProposedAction = {
  id: string;
  actionType: string;
  payload: Record<string, {}>;
  summary: string;
};

const loadMastraAgent = serverOnly(async () => {
  try {
    // Dynamic import to keep it server-only and avoid bundling zod v3 into app
    const mod = await import("../../../server-mastra/src/agent");
    return mod;
  } catch (e) {
    return null;
  }
});

export const proposeFromEmailBridge = serverOnly(
  async (params: { content: string; userId: string }) => {
    const agent = await loadMastraAgent();

    // Resolve per-user LLM settings
    const settings = await db.query.settings.findFirst({
      where: (t, { eq }) => eq(t.userId, params.userId),
    });
    const llmProvider = settings?.llmProvider || "";
    const llmModel = settings?.llmModel || "";
    const llmBaseUrl = settings?.llmBaseUrl || "";
    const llmApiKey = settings?.encryptedLlmApiKey
      ? decrypt(settings.encryptedLlmApiKey)
      : "";

    if ((agent as any)?.proposeFromEmail) {
      return (await (agent as any).proposeFromEmail(params.content, {
        llm: { provider: llmProvider, model: llmModel, baseUrl: llmBaseUrl, apiKey: llmApiKey },
      })) as ProposedAction[];
    }
    const content = params.content;
  // Fallback heuristic if Mastra not installed/configured yet
  const lower = content.toLowerCase();
  const actions: ProposedAction[] = [];
  if (lower.includes("cancel") && lower.includes("order")) {
    actions.push({
      id: randomUUID(),
      actionType: "cancel_order",
      payload: {},
      summary: "Customer requests order cancellation.",
    });
  }
  if (lower.includes("change") && lower.includes("address")) {
    actions.push({
      id: randomUUID(),
      actionType: "update_address",
      payload: {},
      summary: "Customer requests shipping address update.",
    });
  }
  return actions;
},
);

export const runShopifyActionBridge = serverOnly(async (params: {
  actionType: string;
  payload: Record<string, unknown>;
  userId: string;
}): Promise<
  | { ok: true; message?: string; data?: Record<string, {}> }
  | { ok: false; reason: string; details?: Record<string, {}> }
> => {
  const agent = await loadMastraAgent();
  // Resolve Shopify auth for the user
  const row = await db.query.token.findFirst({
    where: (t, { and, eq }) => and(eq(t.userId, params.userId), eq(t.provider, "shopify")),
  });
  if (!row) {
    return { ok: false, reason: "Missing Shopify token" } as const;
  }
  const tokenJson = JSON.parse(decrypt(row.encryptedToken) || "{}") as { access_token?: string; scope?: string };
  const accessToken = tokenJson.access_token;
  // Settings override for shop domain
  const s = await db.query.settings.findFirst({ where: (t, { eq }) => eq(t.userId, params.userId) });
  const shop = s?.shopDomain || (row.meta as any)?.shop || env.SHOPIFY_SHOP;
  if (!accessToken || !shop) {
    return { ok: false, reason: "Invalid Shopify auth" } as const;
  }
  if (agent?.runShopifyAction) {
    return agent.runShopifyAction({
      actionType: params.actionType,
      payload: params.payload,
      auth: { shop, accessToken },
    } as any) as Promise<
      | { ok: true; message?: string; data?: Record<string, {}> }
      | { ok: false; reason: string; details?: Record<string, {}> }
    >;
  }
  // Fallback: just echo without executing
  return { ok: false, reason: "Mastra agent not configured" } as const;
});
