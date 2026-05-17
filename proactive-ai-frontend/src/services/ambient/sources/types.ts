import type { PersonalSignalInput } from "@/lib/devices";

/**
 * Context handed to every source. Sources push PersonalSignal drafts
 * via `push` and report their human-readable last-event summary via
 * `onEvent` (used by DebugPanel for visual feedback).
 */
export interface SourceContext {
  push: (item: PersonalSignalInput) => void;
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
