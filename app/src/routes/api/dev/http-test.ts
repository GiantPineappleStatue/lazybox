import { createServerFileRoute } from "@tanstack/react-start/server";
import { getWebRequest } from "@tanstack/react-start/server";
import { auth } from "~/lib/auth";

const isProd = process.env.NODE_ENV === "production";

// In-memory test state (dev-only)
const counters = new Map<string, number>();
const idempotencyByKey = new Map<string, string>();

export const ServerRoute = createServerFileRoute("/api/dev/http-test").methods({
  GET: async () => {
    if (isProd) return new Response("Forbidden", { status: 403 });

    const { headers, url } = getWebRequest();
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!session) return new Response("Unauthorized", { status: 401 });

    const u = new URL(url);
    const mode = u.searchParams.get("mode") || "ok";
    const key = u.searchParams.get("key") || session.user.id;

    const bump = () => {
      const n = (counters.get(key) || 0) + 1;
      counters.set(key, n);
      return n;
    };

    // For idempotency echo, also record/compare header
    const idemHdr = (headers as any).get?.("x-idempotency-key") || "";
    if (mode === "echo-idempotency" && idemHdr) {
      const first = idempotencyByKey.get(key);
      if (!first) idempotencyByKey.set(key, idemHdr);
    }

    switch (mode) {
      case "ok": {
        const attempt = bump();
        return Response.json({ ok: true, attempt });
      }
      case "500-then-200": {
        const attempt = bump();
        if (attempt === 1) return Response.json({ ok: false, attempt }, { status: 500 });
        return Response.json({ ok: true, attempt });
      }
      case "429": {
        const attempt = bump();
        return new Response(JSON.stringify({ ok: false, attempt }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }
      case "429-then-200": {
        const attempt = bump();
        if (attempt === 1) {
          return new Response(JSON.stringify({ ok: false, attempt }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "0" },
          });
        }
        return Response.json({ ok: true, attempt });
      }
      case "delay-then-200": {
        const attempt = bump();
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, 500));
        }
        return Response.json({ ok: true, attempt });
      }
      case "echo-idempotency": {
        const attempt = bump();
        const first = idempotencyByKey.get(key);
        const consistent = !!first && first === idemHdr;
        return Response.json({ ok: true, attempt, idempotencyKey: idemHdr || null, consistent });
      }
      default: {
        const attempt = bump();
        return Response.json({ ok: true, attempt, note: "unknown mode treated as ok" });
      }
    }
  },
  POST: async () => {
    // Same behavior as GET but focusing on idempotency echo
    if (isProd) return new Response("Forbidden", { status: 403 });

    const { headers, url } = getWebRequest();
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!session) return new Response("Unauthorized", { status: 401 });

    const u = new URL(url);
    const mode = u.searchParams.get("mode") || "ok";
    const key = u.searchParams.get("key") || session.user.id;

    const bump = () => {
      const n = (counters.get(key) || 0) + 1;
      counters.set(key, n);
      return n;
    };

    const idemHdr = (headers as any).get?.("x-idempotency-key") || "";
    if (mode === "echo-idempotency" && idemHdr) {
      const first = idempotencyByKey.get(key);
      if (!first) idempotencyByKey.set(key, idemHdr);
    }

    if (mode === "429") {
      const attempt = bump();
      return new Response(JSON.stringify({ ok: false, attempt }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    }

    if (mode === "echo-idempotency") {
      const attempt = bump();
      const first = idempotencyByKey.get(key);
      const consistent = !!first && first === idemHdr;
      return Response.json({ ok: true, attempt, idempotencyKey: idemHdr || null, consistent });
    }

    const attempt = bump();
    return Response.json({ ok: true, attempt });
  },
});
