import { serverOnly } from "@tanstack/react-start";
import { randomUUID, createHash } from "node:crypto";
import { db } from "~/lib/db";
import { decrypt } from "~/lib/crypto/secureStore";
import { env } from "~/env/server";
import { proposal as proposalTable, action as actionTable } from "~/lib/db/schema";
import { eq } from "drizzle-orm";

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
      // Route memory by user and a stable thread key for proposals
      const resourceId = params.userId;
      const threadId = `proposeFromEmail`; // single thread per user for proposals
      return (await (agent as any).proposeFromEmail(params.content, {
        llm: {
          provider: llmProvider,
          model: llmModel,
          baseUrl: llmBaseUrl,
          apiKey: llmApiKey,
          resourceId,
          threadId,
        },
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
  | { ok: true; code?: string; message?: string; data?: Record<string, {}> }
  | { ok: false; code: string; message: string; data?: Record<string, {}> }
> => {
  const agent = await loadMastraAgent();
  // Resolve Shopify auth for the user
  const row = await db.query.token.findFirst({
    where: (t, { and, eq }) => and(eq(t.userId, params.userId), eq(t.provider, "shopify")),
  });
  if (!row) {
    return { ok: false, code: "shopify_auth_missing", message: "Missing Shopify token" } as const;
  }
  const tokenJson = JSON.parse(decrypt(row.encryptedToken) || "{}") as { access_token?: string; scope?: string };
  const accessToken = tokenJson.access_token;
  // Settings override for shop domain
  const s = await db.query.settings.findFirst({ where: (t, { eq }) => eq(t.userId, params.userId) });
  const shop = s?.shopDomain || (row.meta as any)?.shop || env.SHOPIFY_SHOP;
  if (!accessToken || !shop) {
    return { ok: false, code: "shopify_auth_invalid", message: "Invalid Shopify auth" } as const;
  }
  if (agent?.runShopifyAction) {
    return agent.runShopifyAction({
      actionType: params.actionType,
      payload: params.payload,
      auth: { shop, accessToken },
    } as any) as Promise<
      | { ok: true; code?: string; message?: string; data?: Record<string, {}> }
      | { ok: false; code: string; message: string; data?: Record<string, {}> }
    >;
  }
  // Fallback: just echo without executing
  return { ok: false, code: "agent_not_configured", message: "Mastra agent not configured" } as const;
});

export const orchestrateEmailBridge = serverOnly(
  async (params: { content: string; userId: string; execute?: boolean; emailId?: string }) => {
    const [agent, orchestrator] = await Promise.all([
      loadMastraAgent(),
      // Dynamic import to avoid bundling server-only deps into the app
      import("../../../server-mastra/src/orchestrator"),
    ]);

    // Resolve per-user LLM settings
    const settings = await db.query.settings.findFirst({ where: (t, { eq }) => eq(t.userId, params.userId) });
    const llmProvider = settings?.llmProvider || "";
    const llmModel = settings?.llmModel || "";
    const llmBaseUrl = settings?.llmBaseUrl || "";
    const llmApiKey = settings?.encryptedLlmApiKey ? decrypt(settings.encryptedLlmApiKey) : "";

    // Optional Shopify auth if execute=true
    let shopifyAuth: { shop: string; accessToken: string } | undefined;
    if (params.execute) {
      const row = await db.query.token.findFirst({ where: (t, { and, eq }) => and(eq(t.userId, params.userId), eq(t.provider, "shopify")) });
      const tokenJson = row ? (JSON.parse(decrypt(row.encryptedToken) || "{}") as { access_token?: string }) : undefined;
      const accessToken = tokenJson?.access_token;
      const s = await db.query.settings.findFirst({ where: (t, { eq }) => eq(t.userId, params.userId) });
      const shop = s?.shopDomain || (row as any)?.meta?.shop || env.SHOPIFY_SHOP;
      if (accessToken && shop) {
        shopifyAuth = { shop, accessToken };
      }
    }

    if ((orchestrator as any)?.orchestrateEmail) {
      // DB-backed reporter sink
      const emailId = params.emailId;
      const reporter: any = {
        onProposed: async (proposed: ProposedAction[]) => {
          for (const p of proposed) {
            const payloadHash = createHash("sha256").update(JSON.stringify(p.payload || {})).digest("hex");
            await db
              .insert(proposalTable)
              .values({
                id: p.id,
                emailId: emailId || "",
                userId: params.userId,
                actionType: p.actionType,
                payloadJson: p.payload || {},
                payloadHash,
                modelMeta: { provider: llmProvider, model: llmModel, baseUrl: llmBaseUrl },
              })
              .onConflictDoNothing({ target: [proposalTable.emailId, proposalTable.actionType, proposalTable.payloadHash] });
          }
        },
        onExecuted: async (executed: Array<{ id: string; actionType: string; ok: boolean; message?: string; code?: string; data?: Record<string, unknown> }>) => {
          for (const rec of executed) {
            // action id == proposal id for traceability
            await db.insert(actionTable).values({
              id: rec.id,
              proposalId: rec.id,
              status: rec.ok ? "executed" : "failed",
              resultJson: rec.ok ? (rec.data ?? null) : null,
              error: rec.ok ? null : rec.message ?? rec.code ?? "",
              executedAt: new Date(),
            }).onConflictDoNothing();
            // update proposal status
            await db.update(proposalTable).set({ status: rec.ok ? "executed" : "failed", updatedAt: new Date() }).where(eq(proposalTable.id, rec.id));
          }
        },
      };

      return (orchestrator as any).orchestrateEmail({
        content: params.content,
        llm: { provider: llmProvider, model: llmModel, baseUrl: llmBaseUrl, apiKey: llmApiKey },
        execute: Boolean(params.execute),
        shopifyAuth,
        reporter,
      });
    }

    // Fallback: if orchestrator missing, directly call proposeFromEmail via agent
    if ((agent as any)?.proposeFromEmail) {
      const resourceId = params.userId;
      const threadId = `proposeFromEmail`;
      const proposed = (await (agent as any).proposeFromEmail(params.content, {
        llm: { provider: llmProvider, model: llmModel, baseUrl: llmBaseUrl, apiKey: llmApiKey, resourceId, threadId },
      })) as ProposedAction[];
      return { proposed, executed: params.execute ? [] : undefined };
    }

    return { proposed: [], executed: params.execute ? [] : undefined };
  },
);
