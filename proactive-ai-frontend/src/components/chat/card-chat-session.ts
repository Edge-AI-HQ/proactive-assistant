export interface BuildChatRequestBodyParams {
  sessionKey: string;
  userText?: string;
  /** Original card object (NOT a JSON string). The fetch layer JSON-
   *  encodes the body once for us; if we double-stringify here the
   *  backend receives a quoted string instead of an object. */
  cardContext?: Record<string, unknown>;
  includeCardContext: boolean;
}

export interface ShouldBootstrapCardChatParams {
  hasExistingHistory: boolean;
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
  return body;
}

export function shouldBootstrapCardChat(
  params: ShouldBootstrapCardChatParams,
): boolean {
  return (
    params.hasCardContext &&
    !params.hasExistingHistory &&
    !params.alreadyBootstrapped &&
    Boolean(params.bootstrapMessage?.trim())
  );
}
