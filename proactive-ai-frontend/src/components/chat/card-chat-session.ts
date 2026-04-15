export interface BuildChatRequestBodyParams {
  sessionKey: string;
  userText?: string;
  cardContextJson?: string;
  includeCardContext: boolean;
}

export interface ShouldBootstrapCardChatParams {
  hasExistingHistory: boolean;
  hasCardContext: boolean;
  alreadyBootstrapped: boolean;
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
  if (params.includeCardContext && params.cardContextJson) {
    body.cardContext = params.cardContextJson;
  }
  return body;
}

export function shouldBootstrapCardChat(
  params: ShouldBootstrapCardChatParams,
): boolean {
  return (
    params.hasCardContext &&
    !params.hasExistingHistory &&
    !params.alreadyBootstrapped
  );
}
