import { pgTable, text, timestamp, jsonb, boolean, integer, uniqueIndex } from "drizzle-orm/pg-core";

export const token = pgTable("token", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(), // e.g., 'shopify' | 'google'
  encryptedToken: text("encrypted_token").notNull(),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
  updatedAt: timestamp("updated_at").$defaultFn(() => new Date()).notNull(),
});

export const email = pgTable(
  "email",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    gmailMessageId: text("gmail_message_id").notNull(),
    threadId: text("thread_id").notNull(),
    historyId: text("history_id"),
    from: text("from").notNull(),
    to: text("to").notNull(),
    subject: text("subject").notNull(),
    snippet: text("snippet"),
    bodyHash: text("body_hash").notNull(),
    labels: jsonb("labels"),
    summary: text("summary"),
    receivedAt: timestamp("received_at").notNull(),
    createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
  },
  (t) => ({
    userGmailMessageUnique: uniqueIndex("email_user_gmail_message_unique").on(t.userId, t.gmailMessageId),
  }),
);

export const proposal = pgTable(
  "proposal",
  {
    id: text("id").primaryKey(),
    emailId: text("email_id").notNull(),
    userId: text("user_id").notNull(),
    actionType: text("action_type").notNull(), // e.g., 'new_order' | 'cancel_order' | 'update_address' | ...
    payloadJson: jsonb("payload_json").notNull(),
    payloadHash: text("payload_hash"),
    status: text("status").$defaultFn(() => "proposed").notNull(), // proposed|approved|rejected|executed|failed
    modelMeta: jsonb("model_meta"),
    createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
    updatedAt: timestamp("updated_at").$defaultFn(() => new Date()).notNull(),
  },
  (t) => ({
    proposalIdemUnique: uniqueIndex("proposal_email_action_payload_unique").on(
      t.emailId,
      t.actionType,
      t.payloadHash,
    ),
  }),
);

export const action = pgTable("action", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull(),
  status: text("status").$defaultFn(() => "pending").notNull(), // pending|executed|failed
  resultJson: jsonb("result_json"),
  error: text("error"),
  executedAt: timestamp("executed_at"),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
});

// Per-user settings exposed in dashboard
export const settings = pgTable("settings", {
  userId: text("user_id").primaryKey(),
  shopDomain: text("shop_domain"),
  gmailLabelQuery: text("gmail_label_query"),
  llmProvider: text("llm_provider"), // e.g. 'openai' | 'anthropic'
  llmModel: text("llm_model"),
  llmBaseUrl: text("llm_base_url"),
  encryptedLlmApiKey: text("encrypted_llm_api_key"),
  gmailAutoPullEnabled: boolean("gmail_auto_pull_enabled").default(false),
  gmailPollingIntervalSec: integer("gmail_polling_interval_sec").default(300),
  // Poll status & delta sync
  lastPollAt: timestamp("last_poll_at"),
  lastPollFetched: integer("last_poll_fetched"),
  lastPollProposed: integer("last_poll_proposed"),
  lastPollError: text("last_poll_error"),
  gmailLastHistoryId: text("gmail_last_history_id"),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
  updatedAt: timestamp("updated_at").$defaultFn(() => new Date()).notNull(),
});
