import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { authMiddleware } from "~/lib/auth/middleware/auth-guard";
import { env } from "~/env/server";
import { proposeFromEmailBridge, orchestrateEmailBridge, type ProposedAction } from "~/lib/agent/bridge";
import { db } from "~/lib/db";
import { email as emailTable, proposal as proposalTable, token as tokenTable, settings as settingsTable } from "~/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { encrypt, decrypt } from "~/lib/crypto/secureStore";
import { randomUUID, createHash } from "node:crypto";
import { fetchWithRetry } from "~/lib/http/fetch";

const isDev = process.env.NODE_ENV !== "production";

// In-memory per-process lock map to prevent concurrent polls per user
const activePolls = new Map<string, Promise<
  | { ok: true; data: { disabled: boolean; fetched: number; proposed: number; labelQuery: string } }
  | { ok: false; code?: string; message?: string }
>>();

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
      return { ok: false, code: "GMAIL_NO_TOKEN", message: "No Gmail token" } as const;
    }

    let accessToken = "";
    try {
      const dec = decrypt(tokenRow.encryptedToken);
      const j = JSON.parse(dec || "{}");
      accessToken = j.access_token || j.accessToken || "";
    } catch {}

    if (!accessToken) {
      return { ok: false, code: "GMAIL_NO_ACCESS_TOKEN", message: "Missing Gmail access token" } as const;
    }

    let authHeader = { Authorization: `Bearer ${accessToken}` } as const;
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("q", labelQuery);
    listUrl.searchParams.set("maxResults", String(data.maxResults));
    let listRes = await fetchWithRetry(listUrl.toString(), { headers: authHeader, timeoutMs: 15000, retries: 2, backoffMs: 500 });
    // Attempt refresh on 401
    if (listRes.status === 401) {
      const refreshed = await tryRefreshToken(context.user.id);
      if (refreshed?.accessToken) {
        authHeader = { Authorization: `Bearer ${refreshed.accessToken}` } as const;
        listRes = await fetchWithRetry(listUrl.toString(), { headers: authHeader, timeoutMs: 15000, retries: 2, backoffMs: 500 });
      }
    }
    if (!listRes.ok) {
      return { ok: false, code: "GMAIL_LIST_FAILED", message: `Gmail list failed: ${await listRes.text()}` } as const;
    }
    const listJson = (await listRes.json()) as { messages?: { id: string; threadId: string }[] };
    const messages = listJson.messages ?? [];

    const emails: { id: string; threadId: string; snippet: string; body: string }[] = [];
    for (const m of messages) {
      const getUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`;
      let getRes = await fetchWithRetry(getUrl.toString(), { headers: authHeader, timeoutMs: 15000, retries: 2, backoffMs: 500 });
      if (getRes.status === 401) {
        const refreshed = await tryRefreshToken(context.user.id);
        if (refreshed?.accessToken) {
          authHeader = { Authorization: `Bearer ${refreshed.accessToken}` } as const;
          getRes = await fetchWithRetry(getUrl.toString(), { headers: authHeader, timeoutMs: 15000, retries: 2, backoffMs: 500 });
        }
      }
      if (!getRes.ok) continue;
      const msg = (await getRes.json()) as any;
      const snippet: string = msg.snippet ?? "";
      const bodyText = extractBodyText(msg);
      emails.push({ id: m.id, threadId: m.threadId, snippet, body: bodyText });
    }
    return { ok: true, data: { emails, labelQuery, userId: context.user.id } } as const;
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
    const proposals = await proposeFromEmailBridge({ content: data.content, userId: context.user.id });
    return { ok: true, data: { proposals, userId: context.user.id } } as const;
  });

export const orchestrate = createServerFn()
  .middleware([authMiddleware])
  .validator(
    z.object({
      emailId: z.string(),
      content: z.string(),
      execute: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    if (!context?.user) {
      throw new Error("Unauthorized");
    }
    const userId = context.user.id;
    const result = (await orchestrateEmailBridge({ content: data.content, userId, execute: Boolean(data.execute), emailId: data.emailId })) as {
      proposed: ProposedAction[];
      executed?: Array<{ id: string; actionType: string; ok: boolean; message?: string; code?: string; data?: Record<string, {}> }>;
    };
    return { ok: true, data: { proposed: result.proposed, executed: result.executed ?? [] } } as const;
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
    // Load Gmail OAuth token
    const tokenRow = await db.query.token.findFirst({
      where: (t, ops) => ops.and(ops.eq(t.userId, context.user.id), ops.or(ops.eq(t.provider, "google"), ops.eq(t.provider, "gmail"))),
    });
    if (!tokenRow) {
      return { ok: false, code: "GMAIL_NO_TOKEN", message: "No Gmail token" } as const;
    }
    let tokenJson: any = {};
    try {
      tokenJson = JSON.parse(decrypt(tokenRow.encryptedToken) || "{}");
    } catch {}
    let accessToken: string = tokenJson.access_token || tokenJson.accessToken || "";
    if (!accessToken) {
      return { ok: false, code: "GMAIL_NO_ACCESS_TOKEN", message: "Missing Gmail access token" } as const;
    }

    // Compose MIME message (text/plain)
    const headers = [
      `To: ${data.to}`,
      `Subject: ${data.subject}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
    ].join("\r\n");
    const mime = `${headers}\r\n\r\n${data.body}\r\n`;
    const raw = encodeUtf8ToBase64Url(mime);

    let authHeader = { Authorization: `Bearer ${accessToken}` } as const;
    const doSend = async () =>
      await fetchWithRetry("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ raw, threadId: data.threadId }),
        timeoutMs: 15000,
        retries: 2,
        backoffMs: 500,
      });

    let res = await doSend();
    // Attempt refresh on 401 once
    if (res.status === 401) {
      const refreshed = await doRefresh(tokenRow.id, tokenJson);
      if (refreshed?.accessToken) {
        accessToken = refreshed.accessToken;
        tokenJson = refreshed.tokenJson;
        authHeader = { Authorization: `Bearer ${accessToken}` } as const;
        res = await doSend();
      }
    }
    // No manual backoff — fetchWithRetry already retried above.

    if (!res.ok) {
      const errTxt = await res.text();
      if (isDev) console.error("[gmail] sendReply failed", { userId: context.user.id, status: res.status, err: errTxt });
      return { ok: false, code: "GMAIL_SEND_FAILED", message: `Gmail send failed: ${errTxt}` } as const;
    }
    const json = (await res.json()) as any;
    return { ok: true, data: { id: json.id as string, threadId: json.threadId as string } } as const;
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
    const userId = context.user.id;

    // Throttle: enforce a minimal interval between polls based on lastPollAt
    try {
      const settings = await db.query.settings.findFirst({ where: (t, { eq }) => eq(t.userId, userId) });
      const last = settings?.lastPollAt ? new Date(settings.lastPollAt).getTime() : 0;
      const now = Date.now();
      const minIntervalMs = 5000; // 5 seconds server-side throttle
      if (last && now - last < minIntervalMs) {
        const waitMs = minIntervalMs - (now - last);
        if (isDev) console.info("[poll] throttled", { userId, waitMs });
        return { ok: false, code: "POLL_THROTTLED", message: `Please wait ${Math.ceil(waitMs / 1000)}s before polling again.` } as const;
      }
    } catch {}

    // Concurrency guard: if a poll is already running for this user, do not start another
    const existing = activePolls.get(userId);
    if (existing) {
      if (isDev) console.info("[poll] already-running", { userId });
      return { ok: false, code: "POLL_CONCURRENT", message: "A poll is already running for this user." } as const;
    }

    const inFlight = (async () => await pollForUser(userId, data.maxResults))();
    activePolls.set(userId, inFlight);
    try {
      const result = await inFlight;
      return result;
    } finally {
      activePolls.delete(userId);
    }
  });

export async function pollForUser(userId: string, maxResults: number) {
  // Check settings for auto-pull and label query
  const settings = await db.query.settings.findFirst({
    where: (t, { eq }) => eq(t.userId, userId),
  });
  const enabled = settings?.gmailAutoPullEnabled ?? false;
  const labelQuery = settings?.gmailLabelQuery ?? env.GMAIL_LABEL_QUERY;
  if (isDev) console.info("[poll] start", { userId, enabled, maxResults, labelQuery });
  if (!enabled) {
    return { ok: true, data: { disabled: true, fetched: 0, proposed: 0, labelQuery } } as const;
  }

  // Get token JSON
  const tokenRow = await db.query.token.findFirst({
    where: (t, ops) => ops.and(ops.eq(t.userId, userId), ops.or(ops.eq(t.provider, "google"), ops.eq(t.provider, "gmail"))),
  });
  if (!tokenRow) {
    return { ok: false, code: "GMAIL_NO_TOKEN", message: "No Gmail token" } as const;
  }
  let tokenJson: any = {};
  try {
    tokenJson = JSON.parse(decrypt(tokenRow.encryptedToken) || "{}");
  } catch {
    tokenJson = {};
  }
  let accessToken: string = tokenJson.access_token || tokenJson.accessToken || "";
  if (!accessToken) {
    return { ok: false, code: "GMAIL_NO_ACCESS_TOKEN", message: "Missing Gmail access token" } as const;
  }

  // Helper that handles 401 refresh + retry/backoff for 429/5xx
  let authHeader = { Authorization: `Bearer ${accessToken}` } as const;
  const fetchWithAuthRetry = async (input: string | URL, init?: RequestInit) => {
    const doFetch = async () =>
      await fetchWithRetry(typeof input === "string" ? input : input.toString(), {
        method: init?.method || "GET",
        headers: { ...(init?.headers || {} as any), ...authHeader } as any,
        body: init?.body as any,
        timeoutMs: 15000,
        retries: 3,
        backoffMs: 500,
      });
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
      if (isDev) console.error("[poll] gmail list failed", { userId, err: errTxt });
      await db
        .update(settingsTable)
        .set({ lastPollAt: new Date(), lastPollFetched: 0, lastPollProposed: 0, lastPollError: `Gmail list failed: ${errTxt}` })
        .where(eq(settingsTable.userId, userId));
      return { ok: false, code: "GMAIL_LIST_FAILED", message: `Gmail list failed: ${errTxt}` } as const;
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
  if (isDev) console.info("[poll] complete", { userId, fetched, proposed, labelQuery, newHistoryId: newHistoryId ?? null });
  return { ok: true, data: { disabled: false, fetched, proposed, labelQuery } } as const;
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
  const res = await fetchWithRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    timeoutMs: 10000,
    retries: 2,
    backoffMs: 400,
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

function encodeUtf8ToBase64Url(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
