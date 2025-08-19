import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { authMiddleware } from "~/lib/auth/middleware/auth-guard";
import { db } from "~/lib/db";
import { proposal as proposalTable, email as emailTable, action as actionTable } from "~/lib/db/schema";
import { and, eq, desc, or, lt, lte, gte, sql, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { runShopifyActionBridge } from "~/lib/agent/bridge";

export const listProposals = createServerFn()
  .middleware([authMiddleware])
  .validator(
    z.object({
      status: z.enum(["proposed", "approved", "rejected", "executed", "failed"]).optional(),
      actionType: z.string().optional(),
      dateFrom: z.string().datetime().optional(),
      dateTo: z.string().datetime().optional(),
      q: z.string().max(200).optional(),
      limit: z.number().int().positive().max(100).default(20),
      cursor: z.string().optional(), // base64 encoded "createdAtIso|id"
    }),
  )
  .handler(async ({ data, context }) => {
    if (!context?.user) throw new Error("Unauthorized");

    // Decode cursor
    let cursorCreatedAt: Date | null = null;
    let cursorId: string | null = null;
    if (data.cursor) {
      try {
        const [ts, id] = Buffer.from(data.cursor, "base64").toString("utf8").split("|");
        cursorCreatedAt = ts ? new Date(ts) : null;
        cursorId = id || null;
      } catch {}
    }

    // Build filters
    const filters: any[] = [eq(proposalTable.userId, context.user.id)];
    if (data.status) filters.push(eq(proposalTable.status, data.status));
    if (data.actionType) filters.push(eq(proposalTable.actionType, data.actionType));
    if (data.dateFrom) filters.push(gte(proposalTable.createdAt, new Date(data.dateFrom)));
    if (data.dateTo) filters.push(lte(proposalTable.createdAt, new Date(data.dateTo)));
    if (cursorCreatedAt && cursorId) {
      // Keyset: createdAt desc, id desc
      filters.push(
        or(
          lt(proposalTable.createdAt, cursorCreatedAt),
          and(eq(proposalTable.createdAt, cursorCreatedAt), lt(proposalTable.id, cursorId)),
        ),
      );
    }

    // Text search across email.snippet and payload_json
    const searchConds: any[] = [];
    if (data.q && data.q.trim()) {
      const like = `%${data.q.trim()}%`;
      searchConds.push(sql`${emailTable.snippet} ILIKE ${like}`);
      searchConds.push(sql`${proposalTable.payloadJson}::text ILIKE ${like}`);
    }

    const where = searchConds.length > 0 ? and(...filters, or(...searchConds)) : and(...filters);

    const rows = await db
      .select({
        id: proposalTable.id,
        emailId: proposalTable.emailId,
        userId: proposalTable.userId,
        actionType: proposalTable.actionType,
        status: proposalTable.status,
        payloadJson: proposalTable.payloadJson,
        modelMeta: proposalTable.modelMeta,
        createdAt: proposalTable.createdAt,
        updatedAt: proposalTable.updatedAt,
        snippet: emailTable.snippet,
        from: emailTable.from,
        subject: emailTable.subject,
        receivedAt: emailTable.receivedAt,
        threadId: emailTable.threadId,
      })
      .from(proposalTable)
      .leftJoin(emailTable, eq(emailTable.id, proposalTable.emailId))
      .where(where)
      .orderBy(desc(proposalTable.createdAt), desc(proposalTable.id))
      .limit(data.limit + 1);

    const items = rows.slice(0, data.limit);
    const hasMore = rows.length > data.limit;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`, "utf8").toString("base64") : null;

    const proposals = items.map((r: any) => ({
      ...r,
      payloadJson: r?.payloadJson ?? {},
      modelMeta: r?.modelMeta ?? {},
    }));

    // totalCount for the current filters (without cursor)
    const totalRow = await db
      .select({ c: sql<number>`count(*)` })
      .from(proposalTable)
      .leftJoin(emailTable, eq(emailTable.id, proposalTable.emailId))
      .where(
        searchConds.length > 0
          ? and(eq(proposalTable.userId, context.user.id), ...(data.status ? [eq(proposalTable.status, data.status)] : []), ...(data.actionType ? [eq(proposalTable.actionType, data.actionType)] : []), ...(data.dateFrom ? [gte(proposalTable.createdAt, new Date(data.dateFrom))] : []), ...(data.dateTo ? [lte(proposalTable.createdAt, new Date(data.dateTo))] : []), or(...searchConds))
          : and(eq(proposalTable.userId, context.user.id), ...(data.status ? [eq(proposalTable.status, data.status)] : []), ...(data.actionType ? [eq(proposalTable.actionType, data.actionType)] : []), ...(data.dateFrom ? [gte(proposalTable.createdAt, new Date(data.dateFrom))] : []), ...(data.dateTo ? [lte(proposalTable.createdAt, new Date(data.dateTo))] : [])),
      );
    const totalCount = Number((totalRow?.[0]?.c as any) ?? 0);

    return { ok: true, proposals, page: { limit: data.limit, cursor: data.cursor ?? null, nextCursor, hasMore, totalCount } } as const;
  });

export const executeProposal = createServerFn()
  .middleware([authMiddleware])
  .validator(z.object({ proposalId: z.string() }))
  .handler(async ({ data, context }) => {
    if (!context?.user) throw new Error("Unauthorized");
    const row = await db.query.proposal.findFirst({ where: (t, { and, eq }) => and(eq(t.id, data.proposalId), eq(t.userId, context.user.id)) });
    if (!row) return { ok: false, code: "proposal_not_found", message: "Proposal not found" } as const;
    if (row.status !== "proposed" && row.status !== "approved") {
      return { ok: false, code: "invalid_status", message: `Cannot execute in status ${row.status}` } as const;
    }
    const res = await runShopifyActionBridge({ actionType: row.actionType, payload: (row as any).payloadJson || {}, userId: context.user.id });
    const actionId = randomUUID();
    await db.insert(actionTable).values({
      id: actionId,
      proposalId: row.id,
      status: res.ok ? "executed" : "failed",
      resultJson: res.ok ? (res as any).data ?? null : null,
      error: res.ok ? null : ((res as any).message ?? (res as any).code ?? ""),
      executedAt: new Date(),
    });
    await db.update(proposalTable).set({ status: res.ok ? "executed" : "failed", updatedAt: new Date() }).where(eq(proposalTable.id, row.id));
    return res.ok
      ? ({ ok: true, id: actionId } as const)
      : ({ ok: false, code: (res as any).code ?? "execution_failed", message: (res as any).message ?? "Execution failed", id: actionId } as const);
  });

export const reviewProposal = createServerFn()
  .middleware([authMiddleware])
  .validator(z.object({ proposalId: z.string(), decision: z.enum(["approved", "rejected"]) }))
  .handler(async ({ data, context }) => {
    if (!context?.user) throw new Error("Unauthorized");
    const row = await db.query.proposal.findFirst({ where: (t, { and, eq }) => and(eq(t.id, data.proposalId), eq(t.userId, context.user.id)) });
    if (!row) return { ok: false, code: "proposal_not_found", message: "Proposal not found" } as const;
    if (row.status !== "proposed" && row.status !== "approved" && row.status !== "rejected") {
      return { ok: false, code: "invalid_status", message: `Cannot change status from ${row.status}` } as const;
    }
    await db.update(proposalTable).set({ status: data.decision, updatedAt: new Date() }).where(eq(proposalTable.id, row.id));
    return { ok: true } as const;
  });

export const bulkReviewProposals = createServerFn()
  .middleware([authMiddleware])
  .validator(z.object({ proposalIds: z.array(z.string()).min(1), decision: z.enum(["approved", "rejected"]) }))
  .handler(async ({ data, context }) => {
    if (!context?.user) throw new Error("Unauthorized");
    const res = await db
      .update(proposalTable)
      .set({ status: data.decision, updatedAt: new Date() })
      .where(
        and(
          eq(proposalTable.userId, context.user.id),
          inArray(proposalTable.id, data.proposalIds),
          or(eq(proposalTable.status, "proposed"), eq(proposalTable.status, "approved"), eq(proposalTable.status, "rejected")),
        ),
      )
      .returning({ id: proposalTable.id });
    return { ok: true, updated: res.map((r) => r.id) } as const;
  });

export const getProposalAction = createServerFn()
  .middleware([authMiddleware])
  .validator(z.object({ proposalId: z.string() }))
  .handler(async ({ data, context }) => {
    if (!context?.user) throw new Error("Unauthorized");
    const row = await db
      .select({
        id: actionTable.id,
        status: actionTable.status,
        resultJson: actionTable.resultJson,
        error: actionTable.error,
        executedAt: actionTable.executedAt,
        createdAt: actionTable.createdAt,
      })
      .from(actionTable)
      .leftJoin(proposalTable, eq(proposalTable.id, actionTable.proposalId))
      .where(and(eq(proposalTable.userId, context.user.id), eq(actionTable.proposalId, data.proposalId)))
      .orderBy(desc(actionTable.createdAt))
      .limit(1);
    const action = row?.[0]
      ? ({
          ...row[0],
          resultJson: (row[0] as any).resultJson ?? {},
        } as const)
      : null;
    return { ok: true, action } as const;
  });

export const countProposalsByStatus = createServerFn()
  .middleware([authMiddleware])
  .validator(z.object({ actionType: z.string().optional(), dateFrom: z.string().datetime().optional(), dateTo: z.string().datetime().optional(), q: z.string().optional() }))
  .handler(async ({ data, context }) => {
    if (!context?.user) throw new Error("Unauthorized");
    const filters: any[] = [eq(proposalTable.userId, context.user.id)];
    if (data.actionType) filters.push(eq(proposalTable.actionType, data.actionType));
    if (data.dateFrom) filters.push(gte(proposalTable.createdAt, new Date(data.dateFrom)));
    if (data.dateTo) filters.push(lte(proposalTable.createdAt, new Date(data.dateTo)));
    const searchConds: any[] = [];
    if (data.q && data.q.trim()) {
      const like = `%${data.q.trim()}%`;
      searchConds.push(sql`${emailTable.snippet} ILIKE ${like}`);
      searchConds.push(sql`${proposalTable.payloadJson}::text ILIKE ${like}`);
    }
    const baseWhere = searchConds.length > 0 ? and(...filters, or(...searchConds)) : and(...filters);
    const statuses = ["proposed", "approved", "rejected", "executed", "failed"] as const;
    const counts: Record<(typeof statuses)[number], number> = {
      proposed: 0,
      approved: 0,
      rejected: 0,
      executed: 0,
      failed: 0,
    };
    for (const s of statuses) {
      const row = await db
        .select({ c: sql<number>`count(*)` })
        .from(proposalTable)
        .leftJoin(emailTable, eq(emailTable.id, proposalTable.emailId))
        .where(and(baseWhere, eq(proposalTable.status, s)));
      counts[s] = Number((row?.[0]?.c as any) ?? 0);
    }
    return { ok: true, counts } as const;
  });
