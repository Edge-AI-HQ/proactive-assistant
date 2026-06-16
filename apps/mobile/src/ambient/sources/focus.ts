/**
 * Focus 源（Swift 保留件：INFocusStatusCenter 经 ambient-visit module）。
 * 状态变化驱动（与 web sources/focus.ts 同语义：同状态去重）。
 * 注：focus 真值需要 com.apple.developer.focus-status entitlement，未
 * 授权时 Swift 侧静默不发——行为与 Capacitor 版一致。
 */
import { AmbientVisit, type FocusEvent } from "../../../modules/ambient-visit";
import {
  type AmbientSource,
  type AmbientSourceStartOptions,
  type SourceContext,
} from "../types";

const FOCUS_KIND = "device.focus_state";

export function createFocusSource(ctx: SourceContext): AmbientSource {
  let sub: { remove(): void } | null = null;
  let lastFocused: boolean | null = null;

  function handle(event: FocusEvent): void {
    if (event.focused === lastFocused) return;
    lastFocused = event.focused;
    const summary = event.focused ? "Focus on" : "Focus off";
    ctx.push({
      kind: FOCUS_KIND,
      title: "Focus state",
      summary,
      occurred_at: new Date(event.timestamp).toISOString(),
      dedupe_key: `focus:${event.focused}:${event.timestamp}`,
      payload: {
        schema_version: "focus_state.v1",
        focused: event.focused,
        observed_at: new Date(event.timestamp).toISOString(),
      },
    });
    ctx.onEvent("focus", summary);
  }

  return {
    key: "focus",
    label: "Focus",
    isStarted: () => sub !== null,
    async start(options?: AmbientSourceStartOptions) {
      if (sub) return;
      if (options?.interactivePermissions === false) {
        throw new Error("focus authorization requires user prompt");
      }
      await AmbientVisit.requestFocusPermissions();
      sub = AmbientVisit.addListener("focus", handle);
      await AmbientVisit.startFocusMonitoring();
    },
    async stop() {
      sub?.remove();
      sub = null;
      await AmbientVisit.stopFocusMonitoring();
      lastFocused = null;
    },
  };
}
