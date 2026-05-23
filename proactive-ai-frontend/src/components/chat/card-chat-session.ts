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
