import { createServerFileRoute } from "@tanstack/react-start/server";
import { randomUUID } from "node:crypto";
import { env } from "~/env/server";

export const ServerRoute = createServerFileRoute("/api/gmail/auth").methods({
  GET: async () => {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT) {
      return new Response("Missing Google OAuth envs", { status: 500 });
    }

    const state = randomUUID();
    const scopes =
      env.GOOGLE_SCOPES?.trim() ||
      [
        "https://www.googleapis.com/auth/gmail.readonly",
        // Add profile scopes if needed
      ].join(" ");

    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: env.GOOGLE_REDIRECT,
      response_type: "code",
      scope: scopes,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });

    const headers = new Headers({
      Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      "Set-Cookie": `gmail_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
    });
    return new Response(null, { status: 302, headers });
  },
});
