import type { ClientHints } from "@/hooks/useClientHints";

export interface BuildChatRequestBodyParams {
  sessionKey: string;
  userText?: string;
  /** Original card object (NOT a JSON string). The fetch layer JSON-
   *  encodes the body once for us; if we double-stringify here the
   *  backend receives a quoted string instead of an object. */
  cardContext?: Record<string, unknown>;
  includeCardContext: boolean;
  /** Device hints — drives backend BrowserBase session viewport + UA
   *  profile so the in-app browser renders mobile sites correctly on
   *  mobile, etc. Omit for environments where we don't want device
   *  detection (tests). */
  clientHints?: ClientHints;
}

export interface ShouldBootstrapCardChatParams {
  hasExistingHistory: boolean;
  /** Kept for call-site clarity (`true` = card chat, `false` = main chat).
   *  Bootstrap firing no longer requires this — Main Chat's "start new
   *  conversation" path (MinimalistLanding chip / composer) also opens a
   *  fresh thread + bootstraps the user's first message. */
  hasCardContext: boolean;
  alreadyBootstrapped: boolean;
  /** Caller-provided text to send as the user's first message. Without it,
   *  bootstrap is suppressed — opening a card via the "Chat" button just
   *  reveals an empty thread and waits for the user to type. */
  bootstrapMessage?: string;
}

export interface ShouldIncludeCardContextParams {
  hasCardContext: boolean;
  isFreshThread: boolean;
  sessionKey: string;
}

export interface BuildRequestUserTextParams {
  sessionKey: string;
  userText: string;
  cardContext?: Record<string, unknown>;
}

const CARD_FEEDBACK_CONTEXT_RE =
  /^<current_feedback_card>[\s\S]*?<\/current_feedback_card>\s*\n+User message:\n/;

export function buildChatRequestBody(
  params: BuildChatRequestBodyParams,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sessionKey: params.sessionKey,
  };
  const trimmedUserText = params.userText?.trim();
  if (trimmedUserText) {
    body.message = trimmedUserText;
  }
  if (params.includeCardContext && params.cardContext) {
    body.cardContext = params.cardContext;
  }
  if (params.clientHints) {
    body.clientHints = params.clientHints;
  }
  return body;
}

export function shouldBootstrapCardChat(
  params: ShouldBootstrapCardChatParams,
): boolean {
  // hasCardContext is intentionally not gated — both Card Chat (with
  // cardContext) and Main Chat's new-conversation path (no cardContext)
  // bootstrap on a fresh thread when the caller hands us a message.
  return (
    !params.hasExistingHistory &&
    !params.alreadyBootstrapped &&
    Boolean(params.bootstrapMessage?.trim())
  );
}

export function shouldIncludeCardContext(
  params: ShouldIncludeCardContextParams,
): boolean {
  if (!params.hasCardContext) return false;
  if (!params.sessionKey.startsWith("card-thread-")) return true;
  return params.isFreshThread;
}

export function buildRequestUserText(params: BuildRequestUserTextParams): string {
  if (!params.cardContext) {
    return params.userText;
  }
  return [
    "<current_feedback_card>",
    "The user is giving feedback on this exact current card. Use this card when they say this card / 这张卡 / 当前卡片.",
    JSON.stringify(params.cardContext, null, 2),
    "</current_feedback_card>",
    "",
    "User message:",
    params.userText,
  ].join("\n");
}

export function stripRequestOnlyCardContext(text: string): string {
  return text.replace(CARD_FEEDBACK_CONTEXT_RE, "");
}
