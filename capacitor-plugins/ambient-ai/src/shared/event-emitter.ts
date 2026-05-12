import type { PluginListenerHandle } from '@capacitor/core';

type AnyFn = (data: never) => void;

/**
 * Minimal Capacitor-shaped event emitter used by TS adapters that wrap
 * community plugins. Provides the same surface as `registerPlugin` plugin
 * instances (`addListener` returning a `PluginListenerHandle`,
 * `removeAllListeners`).
 *
 * Listener dispatch happens entirely in the JS runtime — no Capacitor bridge
 * round-trip — so we always log dispatched events at `debug` level to keep
 * adapter behavior observable in dev consoles.
 *
 * Subclasses override `addListener` with the precise plugin interface
 * signature; this base class only persists/dispatches by event name and
 * leaves payload typing to the subclass via `emitTyped`.
 */
export class EventEmitter {
  private listeners = new Map<string, Set<AnyFn>>();

  constructor(private readonly debugLabel: string) {}

  addListener(event: string, fn: AnyFn): Promise<PluginListenerHandle> {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return Promise.resolve({
      remove: async () => {
        this.listeners.get(event)?.delete(fn);
      },
    });
  }

  protected emitTyped<T>(event: string, data: T): void {
    console.debug(`[${this.debugLabel}]`, event, data);
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) (fn as (d: T) => void)(data);
  }

  removeAllListeners(): Promise<void> {
    this.listeners.clear();
    return Promise.resolve();
  }
}
