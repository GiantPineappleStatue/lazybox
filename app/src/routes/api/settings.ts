import { createServerFileRoute } from "@tanstack/react-start/server";
import { auth } from "~/lib/auth";
import { db } from "~/lib/db";
import { settings as settingsTable } from "~/lib/db/schema";
import { env } from "~/env/server";
import { encrypt } from "~/lib/crypto/secureStore";

export const ServerRoute = createServerFileRoute("/api/settings").methods({
  GET: async ({ request }) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return new Response("Unauthorized", { status: 401 });

    const userId = session.user.id;
    const row = await db.query.settings.findFirst({
      where: (t, { eq }) => eq(t.userId, userId),
    });

    const gmailToken = await db.query.token.findFirst({
      where: (t, ops) => ops.and(ops.eq(t.userId, userId), ops.or(ops.eq(t.provider, "google"), ops.eq(t.provider, "gmail"))),
    });

    // Do not return decrypted API key. Only indicate presence.
    const body = {
      shopDomain: row?.shopDomain ?? env.SHOPIFY_SHOP,
      gmailLabelQuery: row?.gmailLabelQuery ?? env.GMAIL_LABEL_QUERY,
      llmProvider: row?.llmProvider ?? "",
      llmModel: row?.llmModel ?? "",
      llmBaseUrl: row?.llmBaseUrl ?? "",
      hasLlmApiKey: !!row?.encryptedLlmApiKey,
      hasGmailToken: !!gmailToken,
      gmailAutoPullEnabled: row?.gmailAutoPullEnabled ?? false,
      gmailPollingIntervalSec: row?.gmailPollingIntervalSec ?? 300,
      lastPollAt: row?.lastPollAt ?? null,
      lastPollFetched: row?.lastPollFetched ?? null,
      lastPollProposed: row?.lastPollProposed ?? null,
      lastPollError: row?.lastPollError ?? null,
      gmailLastHistoryId: row?.gmailLastHistoryId ?? null,
    } as const;

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },

  POST: async ({ request }) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return new Response("Unauthorized", { status: 401 });

    const userId = session.user.id;

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return new Response("Unsupported Media Type", { status: 415 });
    }

    const data = (await request.json()) as Partial<{
      shopDomain: string;
      gmailLabelQuery: string;
      llmProvider: string;
      llmModel: string;
      llmBaseUrl: string;
      llmApiKey: string; // optional, if provided we replace
      gmailAutoPullEnabled: boolean;
      gmailPollingIntervalSec: number;
    }>;

    const now = new Date();
    const set: Record<string, unknown> = {
      shopDomain: data.shopDomain ?? null,
      gmailLabelQuery: data.gmailLabelQuery ?? null,
      llmProvider: data.llmProvider ?? null,
      llmModel: data.llmModel ?? null,
      llmBaseUrl: data.llmBaseUrl ?? null,
      gmailAutoPullEnabled: typeof data.gmailAutoPullEnabled === "boolean" ? data.gmailAutoPullEnabled : undefined,
      gmailPollingIntervalSec: typeof data.gmailPollingIntervalSec === "number" ? data.gmailPollingIntervalSec : undefined,
      updatedAt: now,
    };

    if (typeof data.llmApiKey === "string" && data.llmApiKey.trim().length > 0) {
      set["encryptedLlmApiKey"] = encrypt(data.llmApiKey.trim());
    }

    await db
      .insert(settingsTable)
      .values({
        userId,
        shopDomain: (set.shopDomain as string) ?? null,
        gmailLabelQuery: (set.gmailLabelQuery as string) ?? null,
        llmProvider: (set.llmProvider as string) ?? null,
        llmModel: (set.llmModel as string) ?? null,
        llmBaseUrl: (set.llmBaseUrl as string) ?? null,
        encryptedLlmApiKey: (set["encryptedLlmApiKey"] as string) ?? null,
        gmailAutoPullEnabled: (set.gmailAutoPullEnabled as boolean | undefined) ?? false,
        gmailPollingIntervalSec: (set.gmailPollingIntervalSec as number | undefined) ?? 300,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: settingsTable.userId,
        set,
      });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});
