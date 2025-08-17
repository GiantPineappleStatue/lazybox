import { createServerFileRoute } from "@tanstack/react-start/server";
import { env } from "~/env/server";
import { db } from "~/lib/db";
import { token as tokenTable } from "~/lib/db/schema";
import { encrypt } from "~/lib/crypto/secureStore";
import { auth } from "~/lib/auth";
import { randomUUID } from "node:crypto";

function getCookie(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  const map = Object.fromEntries(
    cookie.split(/;\s*/).filter(Boolean).map((kv) => kv.split("=", 2)),
  );
  return map[name];
}

export const ServerRoute = createServerFileRoute(
  "/api/shopify/callback",
).methods({
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const shop = url.searchParams.get("shop") ?? env.SHOPIFY_SHOP;

    if (!code || !state || !shop) {
      return new Response("Missing required parameters", { status: 400 });
    }

    const cookieState = getCookie(request, "shopify_oauth_state");
    if (!cookieState || cookieState !== state) {
      return new Response("Invalid state", { status: 400 });
    }

    if (!env.SHOPIFY_API_KEY || !env.SHOPIFY_API_SECRET) {
      return new Response("Missing Shopify API credentials", { status: 500 });
    }

    const exchangeRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env.SHOPIFY_API_KEY,
        client_secret: env.SHOPIFY_API_SECRET,
        code,
      }),
    });

    if (!exchangeRes.ok) {
      const txt = await exchangeRes.text();
      return new Response(`Token exchange failed: ${txt}`, { status: 502 });
    }

    const tokenJson = await exchangeRes.json();

    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return new Response("Unauthorized", { status: 401 });
    }

    await db.insert(tokenTable).values({
      id: randomUUID(),
      userId: session.user.id,
      provider: "shopify",
      encryptedToken: encrypt(JSON.stringify(tokenJson)),
      meta: { shop, scope: tokenJson.scope },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const headers = new Headers({
      Location: "/settings",
      // clear state cookie
      "Set-Cookie": `shopify_oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
    });
    return new Response(null, { status: 302, headers });
  },
});
