import type { ProposedAction } from "./agent.js";

export type ExecutionRecord = {
  id: string;
  actionType: ProposedAction["actionType"];
  ok: boolean;
  message?: string;
  code?: string;
  data?: Record<string, unknown>;
};

export type Reporter = {
  onProposed?(actions: ProposedAction[]): void | Promise<void>;
  onExecuted?(records: ExecutionRecord[]): void | Promise<void>;
};

export const defaultReporter: Reporter = {
  async onProposed() {},
  async onExecuted() {},
};
