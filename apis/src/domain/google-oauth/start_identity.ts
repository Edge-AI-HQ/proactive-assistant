export type MiniInitDataVerification =
  | { ok: true; telegramUserId: number; telegramUsername: string | null }
  | { ok: false; error: string };

export type MiniGoogleStartIdentityValidation =
  | { ok: true }
  | { ok: false; error: string; shouldClearSession: boolean };

export const validateMiniGoogleStartIdentity = (
  initDataRaw: string,
  sessionTelegramUserId: number,
  verify: (raw: string) => MiniInitDataVerification,
): MiniGoogleStartIdentityValidation => {
  if (!initDataRaw) {
    return {
      ok: false,
      error: "Unauthorized: missing Telegram init_data",
      shouldClearSession: true,
    };
  }

  const verification = verify(initDataRaw);
  if (!verification.ok) {
    return {
      ok: false,
      error: verification.error,
      shouldClearSession: true,
    };
  }

  if (verification.telegramUserId !== sessionTelegramUserId) {
    return {
      ok: false,
      error: "Unauthorized: session user mismatch",
      shouldClearSession: true,
    };
  }

  return { ok: true };
};
