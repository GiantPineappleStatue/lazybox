import { createServerFileRoute } from "@tanstack/react-start/server";
import { getWebRequest } from "@tanstack/react-start/server";
import { randomUUID } from "node:crypto";
import { db } from "~/lib/db";
import { email as emailTable, proposal as proposalTable } from "~/lib/db/schema";
import { auth } from "~/lib/auth";

const isProd = process.env.NODE_ENV === "production";

export const ServerRoute = createServerFileRoute("/api/dev/seed").methods({
  POST: async () => {
    if (isProd) return new Response("Forbidden", { status: 403 });

    const { headers } = getWebRequest();
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!session) return new Response("Unauthorized", { status: 401 });

    const userId = session.user.id;

    try {
      const now = Date.now();
      const mkEmail = (i: number) => ({
        id: randomUUID(),
        userId,
        gmailMessageId: `test-msg-${randomUUID()}`,
        threadId: `test-thread-${i}`,
        historyId: undefined,
        from: `Customer ${i} <customer${i}@example.com>`,
        to: `Support <support@example.com>`,
        subject: `Order #${1000 + i} Update (${i % 2 === 0 ? "Express" : "Standard"})`,
        snippet: `Customer ${i} requesting ${i % 3 === 0 ? "refund" : "address update"}. Notes: Express Shipping`,
        bodyHash: randomUUID().replace(/-/g, ""),
        labels: ["INBOX", "CATEGORY_PERSONAL"],
        receivedAt: new Date(now - i * 60_000),
        createdAt: new Date(now - i * 60_000),
      });

      const actionTypes = ["new_order", "cancel_order", "update_address", "refund"] as const;
      const statuses = ["proposed", "approved", "rejected", "executed", "failed"] as const;

      // Create a decent volume for pagination tests
      const total = 50;
      const emails = Array.from({ length: total }, (_, i) => mkEmail(i + 1));
      await db.insert(emailTable).values(emails as any).onConflictDoNothing();

      const props = emails.map((e, idx) => ({
        id: randomUUID(),
        emailId: e.id,
        userId,
        actionType: actionTypes[idx % actionTypes.length],
        payloadJson: { orderId: 1000 + idx, note: `seeded-${idx}` },
        payloadHash: undefined,
        status: statuses[idx % statuses.length],
        modelMeta: { seeded: true },
        createdAt: new Date(e.createdAt),
        updatedAt: new Date(e.createdAt),
      }));
      await db.insert(proposalTable).values(props as any).onConflictDoNothing();

      return Response.json({ ok: true, createdEmails: emails.length, createdProposals: props.length });
    } catch (e: any) {
      return Response.json({ ok: false, reason: e?.message || "seed failed" }, { status: 500 });
    }
  },
});
