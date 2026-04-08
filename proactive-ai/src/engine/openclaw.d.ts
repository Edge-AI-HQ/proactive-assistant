/**
 * Minimal type declarations for the OpenClaw Plugin SDK (v2026.4.2).
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
    /** Full OpenClaw config (from ~/.openclaw/openclaw.json). */
    config: Record<string, unknown>;
    /** Plugin-specific config (from ~/.openclaw/plugins/<id>/config.json). */
    pluginConfig: Record<string, unknown>;
    registrationMode: 'full' | 'setup-only' | 'setup-runtime';
    /** Plugin root directory (e.g. ~/.openclaw/plugins/<id>/ or source dir for local-linked). */
    rootDir: string;
    /** Resolve a path relative to the OpenClaw config directory. */
    resolvePath(relativePath: string): string;

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
      nativeNames?: Partial<Record<string, string>> & { default?: string };
      description: string;
      acceptsArgs?: boolean;
      requireAuth?: boolean;
      handler(...args: unknown[]): Promise<string | { text: string; isError?: boolean }>;
    }): void;

    registerService(service: {
      name: string;
      start(): Promise<void>;
      stop(): Promise<void>;
    }): void;

    registerHttpRoute(params: {
      path: string;
      auth: 'plugin' | 'gateway';
      match?: 'exact' | 'prefix';
      replaceExisting?: boolean;
      handler(req: unknown, res: unknown): Promise<boolean | void> | boolean | void;
    }): void;

    on(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;

    runtime: {
      subagent: {
        run(params: {
          sessionKey: string;
          message: string;
          provider?: string;
          model?: string;
          extraSystemPrompt?: string;
          lane?: string;
          deliver?: boolean;
          idempotencyKey?: string;
        }): Promise<{ runId: string }>;

        waitForRun(params: {
          runId: string;
          timeoutMs?: number;
        }): Promise<{ status: 'ok' | 'error' | 'timeout'; error?: string }>;

        getSessionMessages(params: {
          sessionKey: string;
          limit?: number;
        }): Promise<{ messages: unknown[] }>;

        deleteSession(params: {
          sessionKey: string;
          deleteTranscript?: boolean;
        }): Promise<void>;
      };
    };
  }

  export function emptyPluginConfigSchema(): Record<string, unknown>;
}
