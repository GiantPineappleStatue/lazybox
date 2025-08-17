import { createServerFileRoute } from "@tanstack/react-start/server";
import { env } from "~/env/server";
import { db } from "~/lib/db";
import { settings as settingsTable } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { pollForUser } from "~/lib/server/gmail";

export const ServerRoute = createServerFileRoute("/api/cron/gmail-poll").methods({
  GET: async ({ request }) => {
    const secret = request.headers.get("x-cron-secret") || new URL(request.url).searchParams.get("secret");
    if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    const maxResults = Number(url.searchParams.get("maxResults") || 25);
    console.info("[cron] gmail-poll start", { ts: new Date().toISOString(), maxResults });

    // Find users with auto-pull enabled
    const rows = await db
      .select({ userId: settingsTable.userId })
      .from(settingsTable)
      .where(eq(settingsTable.gmailAutoPullEnabled, true));
    console.info("[cron] gmail-poll users", { count: rows.length });

    const results: Array<{ userId: string; fetched: number; proposed: number; disabled?: boolean; ok?: boolean; reason?: string }> = [];
    for (const r of rows) {
      const res = await pollForUser(r.userId, maxResults);
      results.push({ userId: r.userId, ...(res as any) });
      console.info("[cron] gmail-poll user", {
        userId: r.userId,
        ok: (res as any).ok !== false,
        disabled: (res as any).disabled ?? false,
        fetched: (res as any).fetched ?? 0,
        proposed: (res as any).proposed ?? 0,
        reason: (res as any).reason,
      });
    }

    console.info("[cron] gmail-poll complete", { processedUsers: rows.length });
    return new Response(JSON.stringify({ processedUsers: rows.length, results }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});
