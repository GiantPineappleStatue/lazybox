import { createServerFileRoute } from "@tanstack/react-start/server";
import { env } from "~/env/server";
import { randomBytes } from "node:crypto";

export const ServerRoute = createServerFileRoute(
  "/api/shopify/install",
).methods({
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop") ?? env.SHOPIFY_SHOP;

    if (!shop || !env.SHOPIFY_API_KEY) {
      return new Response("Missing shop or SHOPIFY_API_KEY", { status: 400 });
    }

    const state = randomBytes(16).toString("hex");
    const scopes = env.SHOPIFY_SCOPES ?? "";
    const redirectUri = env.SHOPIFY_REDIRECT;

    const authUrl = new URL(`https://${shop}/admin/oauth/authorize`);
    authUrl.searchParams.set("client_id", env.SHOPIFY_API_KEY);
    authUrl.searchParams.set("scope", scopes);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);

    const headers = new Headers({
      Location: authUrl.toString(),
      "Set-Cookie": `shopify_oauth_state=${state}; HttpOnly; Secure; Path=/; SameSite=Lax`,
    });

    return new Response(null, { status: 302, headers });
  },
});
