export const extractStartPayload = (text: string | undefined): string => {
  const raw = (text || '').trim();
  const match = raw.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  return (match?.[1] || '').trim();
};

export const buildGoogleConnectedMessage = (email: string | null): string => {
  const mailbox = email?.trim() || 'your Google mailbox';
  return [
    `✅ <b>Google connected</b>`,
    '',
    `Connected mailbox: <code>${mailbox}</code>`,
    'Credentials have been synced to your assistant container.',
    '',
    'You can now ask things like:',
    '• Show me my latest 10 emails',
    '• Search emails with "invoice" in the subject',
    '• Summarize today\'s new emails',
    '• Show unread emails that need a reply',
  ].join('\n');
};
