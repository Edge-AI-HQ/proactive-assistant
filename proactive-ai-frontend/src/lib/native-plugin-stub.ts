/**
 * Web-only stub for Capacitor native plugins.
 *
 * Vite aliases `@pin/capacitor-ambient-ai` / `@capacitor/geolocation` /
 * `@capacitor-community/{contacts,sqlite}` / `@capgo/capacitor-{barometer,health}`
 * to THIS file when building the web bundle (see vite.config.ts).
 *
 * Why not just keep them as Rollup `external`:
 * marking the imports `external` tells Rollup to not try to resolve at
 * build time — but the output bundle still contains literal
 * `from "@pin/capacitor-ambient-ai"` statements, which the browser
 * cannot resolve at runtime (bare specifiers aren't valid in ES module
 * scripts). Mapping to a stub lets Rollup actually substitute the
 * import with a known module, so the bundle ships without unresolvable
 * specifiers.
 *
 * Behavior: every export is a proxy that returns either an empty
 * function or another proxy on property access, so existing call sites
 * (e.g. `AmbientAi.someMethod(...)`) don't crash on import — they only
 * fail when invoked. Native-only call sites are already gated by
 * `isNative` from `@/lib/platform`, so they never execute on web.
 *
 * On the Capacitor build (`VITE_CAPACITOR=1`) the alias is bypassed
 * and the real native plugins resolve normally.
 */
function makeStub(): unknown {
  const handler: ProxyHandler<object> = {
    get(_target, prop): unknown {
      // Surface the throw-on-actual-use behavior: invoking a plugin
      // method on web should be a loud error (caller is missing an
      // isNative guard), but `import` time + plain property access
      // stay silent so type-level access doesn't blow up.
      if (typeof prop === "string" && /^(then|Symbol|__esModule)$/.test(prop)) {
        // CommonJS interop probes — return undefined so consumers
        // recognise this as a plain ES module export rather than a
        // thenable.
        return undefined;
      }
      return makeStub();
    },
    apply() {
      throw new Error(
        "Native Capacitor plugin invoked on web. This call site is "
        + "missing an `isNative` guard — gate it via "
        + "`@/lib/platform`'s `isNative` and dynamic `import()` "
        + "before reaching the plugin API.",
      );
    },
    construct() {
      return makeStub() as object;
    },
  };
  return new Proxy(function noop() {}, handler);
}

// Named exports cover every binding the real plugins expose that we
// reference in source. Exhaustive list isn't needed — `export const` of
// the same proxy works for all names, since unrelated callers will
// destructure into `proxy.SomeName` which itself returns a proxy.
//
// The plugins we stub:
//   @pin/capacitor-ambient-ai   → AmbientAi, AmbientModels, types
//   @capacitor/geolocation      → Geolocation
//   @capacitor-community/contacts → Contacts
//   @capacitor-community/sqlite → CapacitorSQLite, SQLiteConnection
//   @capgo/capacitor-barometer  → Barometer
//   @capgo/capacitor-health     → CapacitorHealthkit
//
// Vite turns this single stub into the resolved module for ALL aliased
// names, so we just re-export the universal proxy under the most
// common identifiers callers reach for.
// Type-erased export: callers `import { AmbientAi } from "..."` use the
// REAL plugin's class type from their own TS resolution path (the
// declarations files of the native packages stay reachable for type-
// checking even when this stub is the runtime substitute). We can't
// match those types here without taking a dependency on every plugin's
// types — and even if we did, a single Proxy can't satisfy each
// distinct class shape statically. So we widen to `unknown` and let
// each consumer's own type-only import line keep its precise type. The
// runtime stub still satisfies any property access via the Proxy's
// get-handler, so consumers that destructure compile-time-typed
// classes (`AmbientAi.someMethod`) keep working at the type layer and
// blow up loudly at runtime only if actually invoked on web.
const stub = makeStub() as unknown;

export const AmbientAi = stub;
export const AmbientModels = stub;
export const Geolocation = stub;
export const Contacts = stub;
export const CapacitorSQLite = stub;
export const SQLiteConnection = stub;
export const Barometer = stub;
export const CapacitorHealthkit = stub;

// Default export covers `import X from "..."` patterns.
export default stub;
