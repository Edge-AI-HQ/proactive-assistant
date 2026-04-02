/**
 * Minimal type declarations for the OpenClaw Plugin SDK.
 *
 * These are local stubs so the project compiles without the openclaw
 * peer dependency installed. The real types come from the openclaw package
 * at runtime.
 */

declare module 'openclaw/plugin-sdk' {
  export interface OpenClawPluginApi {
    id: string;
    name: string;
    version: string;
    config: Record<string, unknown>;
    pluginConfig: Record<string, unknown>;
    registrationMode: 'full' | 'setup-only' | 'setup-runtime';

    logger: {
      debug(msg: string, ...args: unknown[]): void;
      info(msg: string, ...args: unknown[]): void;
      warn(msg: string, ...args: unknown[]): void;
      error(msg: string, ...args: unknown[]): void;
    };

    registerTool(tool: {
      name: string;
      description: string;
      parameters: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
      };
      execute(toolCallId: string, toolArgs: Record<string, unknown>): Promise<string | { content: Array<{ type: string; text: string }> }>;
    }, opts?: { optional?: boolean }): void;

    registerCommand(command: {
      name: string;
      description: string;
      handler(...args: unknown[]): Promise<string>;
    }): void;

    registerService(service: {
      name: string;
      start(): Promise<void>;
      stop(): Promise<void>;
    }): void;

    registerHttpRoute(params: {
      path: string;
      auth?: 'plugin' | 'gateway';
      match?: 'exact' | 'prefix';
      replaceExisting?: boolean;
      handler(req: unknown, res: unknown): Promise<void>;
    }): void;

    on(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;

    runtime: {
      subagent: {
        run(params: {
          sessionKey: string;
          extraSystemPrompt: string;
          idempotencyKey: string;
          message: string;
          deliver: boolean;
        }): Promise<{ runId: string }>;

        waitForRun(params: {
          runId: string;
          timeoutMs: number;
        }): Promise<{ status: 'ok' | 'completed' | 'failed' | 'timeout'; error?: string }>;

        getSessionMessages(params: {
          sessionKey: string;
          limit: number;
        }): Promise<{ messages: unknown[] }>;

        deleteSession(params: { sessionKey: string }): Promise<void>;
      };
    };
  }

  export function emptyPluginConfigSchema(): Record<string, unknown>;
}
