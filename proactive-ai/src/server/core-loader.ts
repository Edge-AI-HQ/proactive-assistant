let cachedCore: Promise<Record<string, unknown>> | null = null;

export interface CoreModuleLike {
  profile: Record<string, (...args: unknown[]) => Promise<unknown>>;
  personal: Record<string, (...args: unknown[]) => Promise<unknown>>;
  feedback: Record<string, (...args: unknown[]) => Promise<unknown>>;
  CoreError?: new (...args: unknown[]) => { type?: string; code?: string; message?: string; hint?: string };
}

export async function loadCoreModule(): Promise<CoreModuleLike> {
  if (!cachedCore) {
    cachedCore = (async () => {
      try {
        return await import('@pin-ai/core') as Record<string, unknown>;
      } catch {
        const fallbackPath = '../../packages/core/dist/src/index.js';
        return await import(fallbackPath) as Record<string, unknown>;
      }
    })();
  }
  return await cachedCore as unknown as CoreModuleLike;
}

export function readCoreError(error: unknown, core: CoreModuleLike): {
  isCoreError: boolean;
  type: string | null;
  code: string | null;
  message: string;
  hint: string | null;
} {
  const CoreErrorCtor = core.CoreError;
  if (CoreErrorCtor && error instanceof CoreErrorCtor) {
    const e = error as { type?: string; code?: string; message?: string; hint?: string };
    return {
      isCoreError: true,
      type: typeof e.type === 'string' ? e.type : null,
      code: typeof e.code === 'string' ? e.code : null,
      message: typeof e.message === 'string' ? e.message : 'Core error',
      hint: typeof e.hint === 'string' ? e.hint : null,
    };
  }

  const e = error as { type?: unknown; code?: unknown; message?: unknown; hint?: unknown };
  const hasShape =
    typeof e === 'object'
    && e !== null
    && typeof e.message === 'string'
    && typeof e.type === 'string';
  if (hasShape) {
    return {
      isCoreError: true,
      type: e.type as string,
      code: typeof e.code === 'string' ? e.code : null,
      message: e.message as string,
      hint: typeof e.hint === 'string' ? e.hint : null,
    };
  }

  return {
    isCoreError: false,
    type: null,
    code: null,
    message: error instanceof Error ? error.message : String(error),
    hint: null,
  };
}
