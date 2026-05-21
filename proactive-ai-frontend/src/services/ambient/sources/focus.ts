import { AmbientAi, type FocusEvent } from "@pin/capacitor-ambient-ai";
import type { PluginListenerHandle } from "@capacitor/core";
import { SIGNAL_KINDS } from "../kinds";
import type { AmbientSource, SourceContext } from "./types";

export class FocusSource implements AmbientSource {
  readonly key = "focus";
  readonly label = "Focus";

  private listenerHandle: PluginListenerHandle | null = null;
  private started = false;
  private lastFocused: boolean | null = null;

  constructor(private ctx: SourceContext) {}

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const perm = await AmbientAi.notifications.requestPermissions();
    if (perm.notifications !== "granted") {
      throw new Error(`notifications permission ${perm.notifications}`);
    }
    this.listenerHandle = await AmbientAi.addListener("focus", (event) => this.handle(event));
    await AmbientAi.notifications.startMonitoring();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    try {
      await AmbientAi.notifications.stopMonitoring();
    } finally {
      if (this.listenerHandle) {
        await this.listenerHandle.remove();
        this.listenerHandle = null;
      }
      this.started = false;
      this.lastFocused = null;
    }
  }

  private handle(event: FocusEvent): void {
    if (this.lastFocused === event.focused) return;
    this.lastFocused = event.focused;
    const summary = event.focused ? "Focus mode active" : "Focus mode inactive";
    this.ctx.push({
      kind: SIGNAL_KINDS.focusState,
      title: "Focus state",
      summary,
      occurred_at: new Date(event.timestamp).toISOString(),
      payload: {
        schema_version: "focus_state.v1",
        focused: event.focused,
        observed_at: new Date(event.timestamp).toISOString(),
      },
      dedupe_key: `focus:${event.focused}:${event.timestamp}`,
    });
    this.ctx.onEvent(this.key, summary);
  }
}
