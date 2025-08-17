import { createServerFileRoute } from "@tanstack/react-start/server";
import { env } from "~/env/server";
import { auth } from "~/lib/auth";
import { db } from "~/lib/db";
import { token as tokenTable } from "~/lib/db/schema";
import { encrypt } from "~/lib/crypto/secureStore";
import { randomUUID } from "node:crypto";

function getCookie(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  const map = Object.fromEntries(cookie.split(/;\s*/).filter(Boolean).map((kv) => kv.split("=", 2)));
  return map[name];
}

export const ServerRoute = createServerFileRoute("/api/gmail/callback").methods({
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      return new Response("Missing required parameters", { status: 400 });
    }

    const cookieState = getCookie(request, "gmail_oauth_state");
    if (!cookieState || cookieState !== state) {
      return new Response("Invalid state", { status: 400 });
    }

    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT) {
      return new Response("Missing Google OAuth envs", { status: 500 });
    }

    const form = new URLSearchParams({
      client_id: String(env.GOOGLE_CLIENT_ID),
      client_secret: String(env.GOOGLE_CLIENT_SECRET),
      code,
      grant_type: "authorization_code",
      redirect_uri: String(env.GOOGLE_REDIRECT),
    });

    const exchangeRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
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
      provider: "google",
      encryptedToken: encrypt(JSON.stringify(tokenJson)),
      meta: { scope: tokenJson.scope, token_type: tokenJson.token_type, expires_in: tokenJson.expires_in },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const headers = new Headers({
      Location: "/settings",
      "Set-Cookie": `gmail_oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
    });
    return new Response(null, { status: 302, headers });
  },
});
