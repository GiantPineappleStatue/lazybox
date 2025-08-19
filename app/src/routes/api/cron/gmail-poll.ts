import { createServerFileRoute } from "@tanstack/react-start/server";
import { env } from "~/env/server";
import { db } from "~/lib/db";
import { settings as settingsTable } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { pollForUser } from "~/lib/server/gmail";

const isDev = process.env.NODE_ENV !== "production";

export const ServerRoute = createServerFileRoute("/api/cron/gmail-poll").methods({
  GET: async ({ request }) => {
    const secret = request.headers.get("x-cron-secret") || new URL(request.url).searchParams.get("secret");
    if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    const maxResults = Number(url.searchParams.get("maxResults") || 25);
    if (isDev) console.info("[cron] gmail-poll start", { ts: new Date().toISOString(), maxResults });

    // Find users with auto-pull enabled
    const rows = await db
      .select({ userId: settingsTable.userId })
      .from(settingsTable)
      .where(eq(settingsTable.gmailAutoPullEnabled, true));
    if (isDev) console.info("[cron] gmail-poll users", { count: rows.length });

    const results: Array<{ userId: string; ok: boolean; data?: { disabled: boolean; fetched: number; proposed: number; labelQuery?: string }; code?: string; message?: string }> = [];
    for (const r of rows) {
      const res = await pollForUser(r.userId, maxResults);
      results.push({ userId: r.userId, ...(res as any) });
      if (isDev) console.info("[cron] gmail-poll user", {
        userId: r.userId,
        ok: (res as any).ok === true,
        disabled: (res as any).data?.disabled ?? false,
        fetched: (res as any).data?.fetched ?? 0,
        proposed: (res as any).data?.proposed ?? 0,
        code: (res as any).code,
        message: (res as any).message,
      });
    }

    if (isDev) console.info("[cron] gmail-poll complete", { processedUsers: rows.length });
    return new Response(JSON.stringify({ processedUsers: rows.length, results }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});
