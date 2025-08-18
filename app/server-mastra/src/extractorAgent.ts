import { proposeFromEmail, type LlmOptions, type ProposedAction } from "./agent.js";

export async function extractActionsFromEmail(content: string, opts?: { llm?: LlmOptions }): Promise<ProposedAction[]> {
  return proposeFromEmail(content, opts);
}
