import { createEnv } from "@t3-oss/env-core";
import * as z from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.url(),
    VITE_BASE_URL: z.url().default("http://localhost:3000"),
    BETTER_AUTH_SECRET: z.string().min(1),

    // OAuth2 providers, optional, update as needed
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REDIRECT: z
      .string()
      .url()
      .default("http://localhost:3000/api/gmail/callback"),

    // Gmail scopes and query
    GOOGLE_SCOPES: z.string().optional(),
    GMAIL_LABEL_QUERY: z.string().default("label:customer-inquiries newer_than:7d"),

    // Shopify App OAuth
    SHOPIFY_API_KEY: z.string().optional(),
    SHOPIFY_API_SECRET: z.string().optional(),
    SHOPIFY_SCOPES: z.string().optional(),
    SHOPIFY_REDIRECT: z
      .string()
      .url()
      .default("http://localhost:3000/api/shopify/callback"),
    SHOPIFY_SHOP: z.string().default("r901.myshopify.com"),

    // Encryption key for secure storage (32-byte hex recommended)
    MASTER_KEY: z.string().min(32),

    // Cron secret for authorized background polling
    CRON_SECRET: z.string().optional(),
  },
  runtimeEnv: process.env,
});
