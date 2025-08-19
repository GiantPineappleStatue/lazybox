import { createServerFileRoute } from "@tanstack/react-start/server";
import { getWebRequest } from "@tanstack/react-start/server";
import { auth } from "~/lib/auth";
import { fetchWithRetry, safeJson } from "~/lib/http/fetch";

const isProd = process.env.NODE_ENV === "production";

export const ServerRoute = createServerFileRoute("/api/dev/http-probe").methods({
  GET: async () => {
    if (isProd) return new Response("Forbidden", { status: 403 });

    const { headers, url } = getWebRequest();
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!session) return new Response("Unauthorized", { status: 401 });

    const u = new URL(url);
    const origin = `${u.protocol}//${u.host}`;
    const mode = u.searchParams.get("mode") || "ok";
    const method = (u.searchParams.get("method") || "GET").toUpperCase();
    const timeoutMs = Number(u.searchParams.get("timeoutMs") || "");
    const retries = Number(u.searchParams.get("retries") || "");
    const backoffMs = Number(u.searchParams.get("backoffMs") || "");

    const key = session.user.id;
    const target = `${origin}/api/dev/http-test?mode=${encodeURIComponent(mode)}&key=${encodeURIComponent(key)}`;

    const res = await fetchWithRetry(target, {
      method,
      headers: { "content-type": "application/json" },
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
      retries: Number.isFinite(retries) && retries >= 0 ? retries : undefined,
      backoffMs: Number.isFinite(backoffMs) && backoffMs >= 0 ? backoffMs : undefined,
    });
    const data = await safeJson(res);
    return Response.json({ status: res.status, ok: res.ok, data });
  },
  POST: async () => {
    if (isProd) return new Response("Forbidden", { status: 403 });

    const { headers, url } = getWebRequest();
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!session) return new Response("Unauthorized", { status: 401 });

    const u = new URL(url);
    const origin = `${u.protocol}//${u.host}`;
    const mode = u.searchParams.get("mode") || "ok";
    const timeoutMs = Number(u.searchParams.get("timeoutMs") || "");
    const retries = Number(u.searchParams.get("retries") || "");
    const backoffMs = Number(u.searchParams.get("backoffMs") || "");

    const key = session.user.id;
    const target = `${origin}/api/dev/http-test?mode=${encodeURIComponent(mode)}&key=${encodeURIComponent(key)}`;

    const res = await fetchWithRetry(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
      retries: Number.isFinite(retries) && retries >= 0 ? retries : undefined,
      backoffMs: Number.isFinite(backoffMs) && backoffMs >= 0 ? backoffMs : undefined,
      body: JSON.stringify({ t: Date.now() }),
    });
    const data = await safeJson(res);
    return Response.json({ status: res.status, ok: res.ok, data });
  },
});
