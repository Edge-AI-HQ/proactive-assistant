// Platform-free ambient-source port contracts (lifted from web
// services/ambient/sources/types.ts). The shared interfaces every native
// collection source implements; the concrete sources (sound classifier,
// location, health, visit, activity, focus, calendar, audio route, device
// state) stay in each app because they bind platform SDKs. RN sources will
// implement the same port. Web re-exports from here so existing
// `@/services/ambient/sources/types` importers are unaffected.
import type { PersonalSignalInput } from "../signals";

/**
 * Context handed to every source. Sources push PersonalSignal drafts
 * via `push` and report their human-readable last-event summary via
 * `onEvent` (used by DebugPanel for visual feedback).
 */
export interface SourceContext {
  push: (item: PersonalSignalInput) => void;
  pushDurable?: (item: PersonalSignalInput) => Promise<void>;
  onEvent: (sourceKey: string, summary: string) => void;
  getTranscriptionLanguage?: () => string | null | undefined;
}

/** Common shape every ambient source implements. */
export interface AmbientSource {
  readonly key: string;
  readonly label: string;
  isStarted(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  refresh?(): Promise<void>;
}
