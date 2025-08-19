import { createServerFileRoute } from "@tanstack/react-start/server";
import { getWebRequest } from "@tanstack/react-start/server";
import { db } from "~/lib/db";
import { email as emailTable, proposal as proposalTable } from "~/lib/db/schema";
import { auth } from "~/lib/auth";
import { eq } from "drizzle-orm";

const isProd = process.env.NODE_ENV === "production";

export const ServerRoute = createServerFileRoute("/api/dev/clear").methods({
  POST: async () => {
    if (isProd) return new Response("Forbidden", { status: 403 });

    const { headers } = getWebRequest();
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!session) return new Response("Unauthorized", { status: 401 });

    const userId = session.user.id;

    try {
      // Delete proposals for this user
      await db.delete(proposalTable).where(eq(proposalTable.userId, userId));
      // Delete emails for this user
      await db.delete(emailTable).where(eq(emailTable.userId, userId));
      return Response.json({ ok: true });
    } catch (e: any) {
      return Response.json({ ok: false, code: "DEV_CLEAR_FAILED", message: e?.message || "clear failed" }, { status: 500 });
    }
  },
});
