export const ASSISTANT_CONTAINER_NAME_PREFIX = 'pinclaw-bot-';
export const LEGACY_ASSISTANT_CONTAINER_NAME_PREFIX = 'openclaw-assistant-';

export const containerNameForAssistant = (assistantBotId: number): string =>
  `${ASSISTANT_CONTAINER_NAME_PREFIX}${assistantBotId}`;

export const isAssistantContainerName = (value: string | null | undefined): boolean => {
  const normalized = (value || '').trim();
  return (
    normalized.startsWith(ASSISTANT_CONTAINER_NAME_PREFIX) ||
    normalized.startsWith(LEGACY_ASSISTANT_CONTAINER_NAME_PREFIX)
  );
};
