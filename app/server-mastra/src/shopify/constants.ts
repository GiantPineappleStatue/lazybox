export const ALLOWED_ACTIONS = [
  "cancel_order",
  "update_address",
  "resend_order",
] as const;

export type AllowedAction = typeof ALLOWED_ACTIONS[number];
export const allowedActionsText = ALLOWED_ACTIONS.join(", ");
