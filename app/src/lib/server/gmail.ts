import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { authMiddleware } from "~/lib/auth/middleware/auth-guard";
import { env } from "~/env/server";
import { proposeFromEmailBridge } from "~/lib/agent/bridge";
import { db } from "~/lib/db";
import { email as emailTable, proposal as proposalTable, token as tokenTable, settings as settingsTable } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { encrypt, decrypt } from "~/lib/crypto/secureStore";
import { randomUUID, createHash } from "node:crypto";

export const loadEmails = createServerFn()
  .middleware([authMiddleware])
  .validator(
    z.object({
      labelQuery: z.string().optional(),
      maxResults: z.number().int().positive().max(100).default(25),
    }),
  )
  .handler(async ({ data, context }) => {
    if (!context?.user) {
      throw new Error("Unauthorized");
    }
    // Prefer per-user settings for label query
    let labelQuery = data.labelQuery;
    if (!labelQuery) {
      const row = await db.query.settings.findFirst({ where: (t, { eq }) => eq(t.userId, context.user.id) });
      labelQuery = row?.gmailLabelQuery ?? env.GMAIL_LABEL_QUERY;
    }

    // Load Gmail OAuth token
    const tokenRow = await db.query.token.findFirst({
      where: (t, ops) => ops.and(ops.eq(t.userId, context.user.id), ops.or(ops.eq(t.provider, "google"), ops.eq(t.provider, "gmail"))),
    });
    if (!tokenRow) {
      return { emails: [], labelQuery, userId: context.user.id, reason: "No Gmail token" } as const;
    }

    let accessToken = "";
    try {
      const dec = decrypt(tokenRow.encryptedToken);
      const j = JSON.parse(dec || "{}");
      accessToken = j.access_token || j.accessToken || "";
    } catch {}

    if (!accessToken) {
      return { emails: [], labelQuery, userId: context.user.id, reason: "Missing Gmail access token" } as const;
    }

    let authHeader = { Authorization: `Bearer ${accessToken}` } as const;
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("q", labelQuery);
    listUrl.searchParams.set("maxResults", String(data.maxResults));
    let listRes = await fetch(listUrl, { headers: authHeader });
    // Attempt refresh on 401
    if (listRes.status === 401) {
      const refreshed = await tryRefreshToken(context.user.id);
      if (refreshed?.accessToken) {
        authHeader = { Authorization: `Bearer ${refreshed.accessToken}` } as const;
        listRes = await fetch(listUrl, { headers: authHeader });
      }
    }
    if (!listRes.ok) {
      return { emails: [], labelQuery, userId: context.user.id, reason: `Gmail list failed: ${await listRes.text()}` } as const;
    }
    const listJson = (await listRes.json()) as { messages?: { id: string; threadId: string }[] };
    const messages = listJson.messages ?? [];

    const emails: { id: string; threadId: string; snippet: string; body: string }[] = [];
    for (const m of messages) {
      const getUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`;
      let getRes = await fetch(getUrl, { headers: authHeader });
      if (getRes.status === 401) {
        const refreshed = await tryRefreshToken(context.user.id);
        if (refreshed?.accessToken) {
          authHeader = { Authorization: `Bearer ${refreshed.accessToken}` } as const;
          getRes = await fetch(getUrl, { headers: authHeader });
        }
      }
      if (!getRes.ok) continue;
      const msg = (await getRes.json()) as any;
      const snippet: string = msg.snippet ?? "";
      const bodyText = extractBodyText(msg);
      emails.push({ id: m.id, threadId: m.threadId, snippet, body: bodyText });
    }

    return { emails, labelQuery, userId: context.user.id } as const;
  });

export const proposeActions = createServerFn()
  .middleware([authMiddleware])
  .validator(
    z.object({
      emailId: z.string(),
      content: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    if (!context?.user) {
      throw new Error("Unauthorized");
    }
    // TODO: Call Mastra agent with email content to propose Shopify actions
    const proposals = await proposeFromEmailBridge({ content: data.content, userId: context.user.id });
    return { proposals, userId: context.user.id } as const;
  });

export const sendReply = createServerFn()
  .middleware([authMiddleware])
  .validator(
    z.object({
      threadId: z.string(),
      to: z.string(),
      subject: z.string(),
      body: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    if (!context?.user) {
      throw new Error("Unauthorized");
    }
    // TODO: Use Gmail API to send a reply in the thread
    return { ok: true, userId: context.user.id } as const;
  });

export const poll = createServerFn()
  .middleware([authMiddleware])
  .validator(
    z.object({
      maxResults: z.number().int().positive().max(100).default(25),
    }),
  )
  .handler(async ({ data, context }) => {
    if (!context?.user) {
      throw new Error("Unauthorized");
    }
    const result = await pollForUser(context.user.id, data.maxResults);
    return result;
  });

export async function pollForUser(userId: string, maxResults: number) {
  // Check settings for auto-pull and label query
  const settings = await db.query.settings.findFirst({
    where: (t, { eq }) => eq(t.userId, userId),
  });
  const enabled = settings?.gmailAutoPullEnabled ?? false;
  const labelQuery = settings?.gmailLabelQuery ?? env.GMAIL_LABEL_QUERY;
  console.info("[poll] start", { userId, enabled, maxResults, labelQuery });
  if (!enabled) {
    return { ok: true, disabled: true, fetched: 0, proposed: 0, labelQuery } as const;
  }

  // Get token JSON
  const tokenRow = await db.query.token.findFirst({
    where: (t, ops) => ops.and(ops.eq(t.userId, userId), ops.or(ops.eq(t.provider, "google"), ops.eq(t.provider, "gmail"))),
  });
  if (!tokenRow) {
    return { ok: false, reason: "No Gmail token", fetched: 0, proposed: 0, labelQuery } as const;
  }
  let tokenJson: any = {};
  try {
    tokenJson = JSON.parse(decrypt(tokenRow.encryptedToken) || "{}");
  } catch {
    tokenJson = {};
  }
  let accessToken: string = tokenJson.access_token || tokenJson.accessToken || "";
  if (!accessToken) {
    return { ok: false, reason: "Missing Gmail access token", fetched: 0, proposed: 0, labelQuery } as const;
  }

  // Helper that handles 401 refresh + retry/backoff for 429/5xx
  let authHeader = { Authorization: `Bearer ${accessToken}` } as const;
  const fetchWithAuthRetry = async (input: string | URL, init?: RequestInit) => {
    const doFetch = async () => await fetch(input, { ...(init || {}), headers: { ...(init?.headers || {}), ...authHeader } });
    let res = await doFetch();
    // 401 -> refresh once
    if (res.status === 401) {
      const refreshed = await doRefresh(tokenRow.id, tokenJson);
      if (refreshed?.accessToken) {
        authHeader = { Authorization: `Bearer ${refreshed.accessToken}` } as const;
        tokenJson = refreshed.tokenJson;
        res = await doFetch();
      }
    }
    // Backoff for 429/5xx
    let attempt = 0;
    while ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const delay = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, delay));
      res = await doFetch();
      attempt++;
    }
    return res;
  };

  // Delta sync: use Gmail History API if we have a last history id
  let messageIds: { id: string; threadId?: string }[] = [];
  let nextStartHistoryId: string | undefined = settings?.gmailLastHistoryId ?? undefined;
  try {
    if (nextStartHistoryId) {
      const historyUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
      historyUrl.searchParams.set("startHistoryId", String(nextStartHistoryId));
      historyUrl.searchParams.set("maxResults", String(Math.max(100, maxResults)));
      let pageToken: string | undefined = undefined;
      let maxHistorySeen: bigint = BigInt(nextStartHistoryId);
      const ids = new Set<string>();
      for (let page = 0; page < 5; page++) {
        if (pageToken) historyUrl.searchParams.set("pageToken", pageToken);
        const res = await fetchWithAuthRetry(historyUrl);
        if (!res.ok) {
          // If history is too old or invalid, fall back to list
          break;
        }
        const json = (await res.json()) as any;
        const history: any[] = json.history ?? [];
        for (const h of history) {
          try {
            const hid = BigInt(h.id);
            if (hid > maxHistorySeen) maxHistorySeen = hid;
          } catch {}
          for (const add of h.messagesAdded ?? []) {
            const m = add.message;
            if (m?.id) ids.add(m.id as string);
          }
        }
        pageToken = json.nextPageToken;
        if (!pageToken) break;
      }
      messageIds = Array.from(ids).map((id) => ({ id }));
      if (messageIds.length > 0) nextStartHistoryId = String(maxHistorySeen);
    }
  } catch {}

  // Fallback to list with query when no history or empty delta
  if (messageIds.length === 0) {
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("q", labelQuery);
    listUrl.searchParams.set("maxResults", String(maxResults));
    const listRes = await fetchWithAuthRetry(listUrl);
    if (!listRes.ok) {
      const errTxt = await listRes.text();
      console.error("[poll] gmail list failed", { userId, err: errTxt });
      await db
        .update(settingsTable)
        .set({ lastPollAt: new Date(), lastPollFetched: 0, lastPollProposed: 0, lastPollError: `Gmail list failed: ${errTxt}` })
        .where(eq(settingsTable.userId, userId));
      return { ok: false, reason: `Gmail list failed: ${errTxt}`, fetched: 0, proposed: 0, labelQuery } as const;
    }
    const listJson = (await listRes.json()) as { messages?: { id: string; threadId: string }[] };
    const messages = listJson.messages ?? [];
    messageIds = messages;
  }

  let proposed = 0;
  let fetched = 0;
  let maxHistoryFromMessages: bigint | null = null;
  for (const m of messageIds) {
    // Deduplicate by gmailMessageId + userId
    const existing = await db.query.email.findFirst({
      where: (t, ops) => ops.and(ops.eq(t.userId, userId), ops.eq(t.gmailMessageId, m.id)),
    });
    if (existing) continue;

    const getUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`;
    const getRes = await fetchWithAuthRetry(getUrl);
    if (!getRes.ok) continue;
    const msg = (await getRes.json()) as any;

    const headers: Record<string, string> = {};
    try {
      for (const h of msg.payload?.headers ?? []) {
        if (h?.name && h?.value) headers[h.name.toLowerCase()] = h.value as string;
      }
    } catch {}
    const subject = headers["subject"] ?? "";
    const from = headers["from"] ?? "";
    const to = headers["to"] ?? "";
    const dateHeader = headers["date"] ?? undefined;
    const receivedAt = dateHeader ? new Date(dateHeader) : new Date();
    const snippet: string = msg.snippet ?? "";
    const bodyText = extractBodyText(msg);
    const bodyHash = createHash("sha256").update(bodyText).digest("hex");
    const labels = msg.labelIds ?? [];
    const historyId = msg.historyId ? String(msg.historyId) : undefined;
    try {
      if (historyId) {
        const h = BigInt(historyId);
        if (maxHistoryFromMessages === null || h > maxHistoryFromMessages) maxHistoryFromMessages = h;
      }
    } catch {}

    const emailId = randomUUID();
    await db
      .insert(emailTable)
      .values({
        id: emailId,
        userId,
        gmailMessageId: m.id,
        threadId: (m as any).threadId,
        historyId,
        from,
        to,
        subject,
        snippet,
        bodyHash,
        labels,
        receivedAt,
      })
      .onConflictDoNothing({ target: [emailTable.userId, emailTable.gmailMessageId] });
    fetched += 1;

    const content = [snippet, bodyText].filter(Boolean).join("\n\n");
    try {
      const proposals = await proposeFromEmailBridge({ content, userId });
      if (Array.isArray(proposals) && proposals.length) {
        proposed += proposals.length;
        for (const p of proposals) {
          const payload = (p as any).payload ?? {};
          const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
          await db
            .insert(proposalTable)
            .values({
              id: p.id || randomUUID(),
              emailId,
              userId,
              actionType: p.actionType,
              payloadJson: payload,
              payloadHash,
            })
            .onConflictDoNothing({ target: [proposalTable.emailId, proposalTable.actionType, proposalTable.payloadHash] });
        }
      }
    } catch {
      // Swallow agent errors per-email to keep polling resilient
    }
  }

  // Update last poll metadata
  let newHistoryId: string | undefined = nextStartHistoryId;
  if (maxHistoryFromMessages !== null) newHistoryId = String(maxHistoryFromMessages);
  await db
    .update(settingsTable)
    .set({
      lastPollAt: new Date(),
      lastPollFetched: fetched,
      lastPollProposed: proposed,
      lastPollError: null as any,
      gmailLastHistoryId: newHistoryId ?? settings?.gmailLastHistoryId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(settingsTable.userId, userId));
  console.info("[poll] complete", { userId, fetched, proposed, labelQuery, newHistoryId: newHistoryId ?? null });
  return { ok: true, disabled: false, fetched, proposed, labelQuery } as const;
}

async function tryRefreshToken(userId: string): Promise<{ accessToken: string } | null> {
  const tokenRow = await db.query.token.findFirst({
    where: (t, ops) => ops.and(ops.eq(t.userId, userId), ops.or(ops.eq(t.provider, "google"), ops.eq(t.provider, "gmail"))),
  });
  if (!tokenRow) return null;
  let tokenJson: any = {};
  try {
    tokenJson = JSON.parse(decrypt(tokenRow.encryptedToken) || "{}");
  } catch {}
  const refreshed = await doRefresh(tokenRow.id, tokenJson);
  if (!refreshed) return null;
  return { accessToken: refreshed.accessToken };
}

async function doRefresh(tokenId: string, tokenJson: any): Promise<{ accessToken: string; tokenJson: any } | null> {
  const refreshToken = tokenJson.refresh_token || tokenJson.refreshToken;
  if (!refreshToken) return null;
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    grant_type: "refresh_token",
    refresh_token: String(refreshToken),
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return null;
  const json = await res.json();
  const next = { ...tokenJson, ...json };
  await db
    .update(tokenTable)
    .set({ encryptedToken: encrypt(JSON.stringify(next)) })
    .where(eq(tokenTable.id, tokenId));
  const accessToken: string = next.access_token || next.accessToken || "";
  return { accessToken, tokenJson: next };
}
function extractBodyText(msg: any): string {
  try {
    // Prefer text/plain
    let data = findPartDataByMime(msg.payload, "text/plain");
    if (data) return decodeBase64ToUtf8(data);
    // Fallback to text/html and convert to text
    data = findPartDataByMime(msg.payload, "text/html");
    if (data) {
      const html = decodeBase64ToUtf8(data);
      return htmlToText(html);
    }
    return "";
  } catch {
    return "";
  }
}

function findPartDataByMime(payload: any, mime: string): string | null {
  if (!payload) return null;
  if (payload.mimeType === mime && payload.body?.data) return payload.body.data as string;
  const parts = payload.parts as any[] | undefined;
  if (!parts) return null;
  for (const p of parts) {
    const found = findPartDataByMime(p, mime);
    if (found) return found;
  }
  return null;
}

function decodeBase64ToUtf8(data: string): string {
  const buf = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return buf.toString("utf8");
}

function htmlToText(html: string): string {
  try {
    // normalize line breaks for common block elements
    let text = html
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/p\s*>/gi, "\n\n")
      .replace(/<\s*li\s*>/gi, "\n- ")
      .replace(/<\s*\/div\s*>/gi, "\n")
      .replace(/<\s*\/h[1-6]\s*>/gi, "\n\n");
    // strip all tags
    text = text.replace(/<[^>]*>/g, "");
    // decode common entities
    text = text
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    // trim excessive blank lines
    return text.replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return html;
  }
}
