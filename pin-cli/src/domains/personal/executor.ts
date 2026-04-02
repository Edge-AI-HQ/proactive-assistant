import type { CliRuntimeInput } from "../../runtime.js";

export interface PersonalToolExecuteInput {
  connectedAccountId: string;
  userId: string;
  arguments: Record<string, unknown>;
}

export interface PersonalToolExecuteResult {
  data: unknown;
}

export interface PersonalToolExecutor {
  execute(
    toolSlug: string,
    input: PersonalToolExecuteInput,
  ): Promise<PersonalToolExecuteResult>;
}

class NoopPersonalToolExecutor implements PersonalToolExecutor {
  async execute(): Promise<PersonalToolExecuteResult> {
    throw new Error("Composio executor is unavailable");
  }
}

class ComposioPersonalToolExecutor implements PersonalToolExecutor {
  constructor(private readonly apiKey: string) {}

  async execute(
    toolSlug: string,
    input: PersonalToolExecuteInput,
  ): Promise<PersonalToolExecuteResult> {
    const { Composio } = await import("@composio/core");
    const composio = new Composio({ apiKey: this.apiKey });
    const result = await composio.tools.execute(toolSlug, {
      userId: input.userId,
      connectedAccountId: input.connectedAccountId,
      arguments: input.arguments,
      dangerouslySkipVersionCheck: true,
    });

    return {
      data: result.data,
    };
  }
}

export const createPersonalToolExecutor = (
  runtime: CliRuntimeInput,
  override?: PersonalToolExecutor,
): PersonalToolExecutor => {
  if (override) {
    return override;
  }

  const apiKey = runtime.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    return new NoopPersonalToolExecutor();
  }

  return new ComposioPersonalToolExecutor(apiKey);
};
