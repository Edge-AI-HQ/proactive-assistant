export interface FlagMeta {
  name: string;
  type: "string" | "boolean" | "number";
  required: boolean;
  default?: string;
  enum?: string[];
  description: string;
}

export interface CommandMeta {
  domain: string;
  command: string;
  description: string;
  risk: "read" | "write" | "high-risk-write";
  supportsDryRun: boolean;
  flags: FlagMeta[];
}

const commands: CommandMeta[] = [];

export const registerCommand = (meta: CommandMeta): void => {
  commands.push(meta);
};

export const getCommand = (
  domain: string,
  command: string,
): CommandMeta | undefined =>
  commands.find((c) => c.domain === domain && c.command === command);

export const getCommandsByDomain = (domain: string): CommandMeta[] =>
  commands.filter((c) => c.domain === domain);

export const getAllCommands = (): readonly CommandMeta[] => commands;
