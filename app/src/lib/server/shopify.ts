import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { authMiddleware } from "~/lib/auth/middleware/auth-guard";
import { runShopifyActionBridge } from "~/lib/agent/bridge";

export const executeAction = createServerFn()
  .middleware([authMiddleware])
  .validator(
    z.object({
      actionType: z.string(),
      payload: z.any(),
    }),
  )
  .handler(async ({ data, context }) => {
    if (!context?.user) {
      throw new Error("Unauthorized");
    }
    const result = await runShopifyActionBridge({
      actionType: data.actionType,
      payload: (data.payload ?? {}) as Record<string, unknown>,
      userId: context.user.id,
    });
    return { ok: !!(result as any).ok, actionType: data.actionType, result, userId: context.user.id } as const;
  });
