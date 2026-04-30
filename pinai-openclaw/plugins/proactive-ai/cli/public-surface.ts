export const PUBLIC_COMMANDS = {
  raw: [
    ['gmail', 'recent'], ['gmail', 'thread'],
    ['gcal', 'today'], ['gcal', 'week'], ['gcal', 'list'],
    ['slack', 'list'], ['notion', 'list'], ['gdrive', 'list'], ['github', 'list'], ['outlook', 'list'],
    ['device-apps'], ['device-contacts', 'list'], ['device-contacts', 'search'], ['device-health', 'list'],
  ],
  signals: [['recent'], ['list'], ['get']],
  memory: [['list'], ['get'], ['search']],
  profile: [['get'], ['snapshot']],
  world: [['search'], ['headlines'], ['find'], ['list'], ['get'], ['shortlist'], ['context']],
  cards: [['recent']],
  feedback: [['list'], ['get'], ['stats']],
  personal: [['status'], ['connections', 'list'], ['connect'], ['wait'], ['tools', 'search'], ['tools', 'schema'], ['exec']],
  sys: [['schema']],
} as const satisfies Record<string, readonly (readonly string[])[]>;

export const PUBLIC_CLI_SCHEMA: Record<string, string[]> = Object.fromEntries(
  Object.entries(PUBLIC_COMMANDS).map(([domain, commands]) => [
    domain,
    commands.map((parts) => parts.join(' ')),
  ]),
);

export function publicCliDomains(): string[] {
  return Object.keys(PUBLIC_COMMANDS);
}

export function isPublicCliCommand(domain: string, rest: string[]): boolean {
  return PUBLIC_COMMANDS[domain]?.some((pattern) =>
    rest.length >= pattern.length && pattern.every((part, index) => rest[index] === part),
  ) ?? false;
}
