/**
 * Prefix for all Guide Bot inline-button callback data.
 * The telegram-router uses this to distinguish Guide Bot callbacks from
 * OpenClaw callbacks without maintaining a hardcoded list.
 */
export const GUIDE_BOT_CB_PREFIX = "gb:";

export const CREATE_ASSISTANT_COMMAND = "create_claw_assistant";
export const LIST_ASSISTANT_COMMAND = "list_claw_assistant";
export const SUBSCRIBE_COMMAND = "subscribe";
export const GATEWAY_COMMAND = "gateway";
export const RESET_ACCOUNT_COMMAND = "reset_account";

export const guideCommandList = [
  {
    command: "start",
    description: "Get started with your AI assistant",
  },
  {
    command: CREATE_ASSISTANT_COMMAND,
    description: "Create your AI assistant",
  },
  {
    command: LIST_ASSISTANT_COMMAND,
    description: "Show your assistant status",
  },
  {
    command: SUBSCRIBE_COMMAND,
    description: "Subscribe or manage your plan",
  },
  {
    command: GATEWAY_COMMAND,
    description: "Open OpenClaw dashboard",
  },
  {
    command: RESET_ACCOUNT_COMMAND,
    description: "Delete your account and all associated data",
  },
] as const;
