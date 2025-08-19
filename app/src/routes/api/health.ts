import { createServerFileRoute } from "@tanstack/react-start/server";

export const ServerRoute = createServerFileRoute("/api/health").methods({
  GET: async () => {
    return Response.json({ ok: true });
  },
});
