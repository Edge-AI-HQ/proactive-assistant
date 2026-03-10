export type GoogleRedirectState =
  | { kind: 'idle'; manage: boolean }
  | { kind: 'connected'; manage: boolean }
  | { kind: 'disconnected'; manage: boolean }
  | { kind: 'error'; manage: boolean; reason: string };

export const readGoogleRedirectState = (search: string): GoogleRedirectState => {
  const params = new URLSearchParams(search);
  const manage = params.get('manage') === '1';
  const google = (params.get('google') || '').trim();
  if (google === 'connected') return { kind: 'connected', manage };
  if (google === 'disconnected') return { kind: 'disconnected', manage };
  if (google === 'error') {
    return { kind: 'error', manage, reason: (params.get('reason') || 'unknown_error').trim() || 'unknown_error' };
  }
  return { kind: 'idle', manage };
};
