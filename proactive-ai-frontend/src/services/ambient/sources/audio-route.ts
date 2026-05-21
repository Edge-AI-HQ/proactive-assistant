import { AmbientAi, type AudioState } from "@pin/capacitor-ambient-ai";
import type { PluginListenerHandle } from "@capacitor/core";
import { SIGNAL_KINDS } from "../kinds";
import type { AmbientSource, SourceContext } from "./types";

export class AudioRouteSource implements AmbientSource {
  readonly key = "audio_route";
  readonly label = "Audio Route";

  private listenerHandle: PluginListenerHandle | null = null;
  private started = false;
  private lastRouteKey: string | null = null;
  private lastValuableRouteKey: string | null = null;

  constructor(private ctx: SourceContext) {}

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.listenerHandle = await AmbientAi.addListener("audioState", (event) => this.handle(event));
    this.started = true;
    try {
      this.handle(await AmbientAi.audio.getState());
    } catch (err) {
      console.warn("[AudioRouteSource] getState failed", err);
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.listenerHandle) {
      await this.listenerHandle.remove();
      this.listenerHandle = null;
    }
    this.started = false;
    this.lastRouteKey = null;
    this.lastValuableRouteKey = null;
  }

  private handle(event: AudioState): void {
    const routeKey = JSON.stringify({
      inputs: event.routeInputs?.map((port) => port.portType) ?? [],
      outputs: event.routeOutputs?.map((port) => port.portType) ?? [],
      car: event.hasCarAudio === true,
      a2dp: event.hasBluetoothA2DP === true,
      hfp: event.hasBluetoothHFP === true,
      suppressed: event.suppressedReason ?? null,
      engine: event.engineState ?? null,
    });
    if (this.lastRouteKey === routeKey) return;
    this.lastRouteKey = routeKey;

    const valuable = isValuableRoute(event);
    const wasValuable = this.lastValuableRouteKey !== null;
    if (!valuable && !wasValuable) return;

    const summary = valuable
      ? audioRouteSummary(event)
      : "Audio route returned to default output.";
    this.lastValuableRouteKey = valuable ? routeKey : null;
    const observedAt = new Date().toISOString();
    this.ctx.push({
      kind: SIGNAL_KINDS.audioRoute,
      title: "Audio route context",
      summary,
      occurred_at: observedAt,
      payload: {
        schema_version: "audio_route_context.v1",
        route_inputs: event.routeInputs ?? [],
        route_outputs: event.routeOutputs ?? [],
        has_car_audio: event.hasCarAudio === true,
        has_bluetooth_a2dp: event.hasBluetoothA2DP === true,
        has_bluetooth_hfp: event.hasBluetoothHFP === true,
        valuable_route: valuable,
        route_transition: valuable ? "active" : "ended",
        engine_state: event.engineState,
        suppressed: event.suppressed,
        suppressed_reason: event.suppressedReason,
        running: event.running,
        classification_running: event.classificationRunning,
        capture_pipeline_running: event.capturePipelineRunning,
        observed_at: observedAt,
      },
      dedupe_key: `audio_route:${routeKey}:${observedAt}`,
    });
    this.ctx.onEvent(this.key, summary);
  }
}

function isValuableRoute(event: AudioState): boolean {
  if (event.hasCarAudio || event.hasBluetoothA2DP || event.hasBluetoothHFP) return true;
  const ports = [...(event.routeInputs ?? []), ...(event.routeOutputs ?? [])];
  return ports.some((port) => isValuablePort(port.portType));
}

function isValuablePort(portType: string): boolean {
  const normalized = portType.toLowerCase();
  return normalized.includes("headphone")
    || normalized.includes("headset")
    || normalized.includes("bluetooth")
    || normalized.includes("caraudio")
    || normalized.includes("airplay");
}

function audioRouteSummary(event: AudioState): string {
  if (event.hasCarAudio) return "Audio route connected to CarPlay or car audio.";
  if (event.hasBluetoothA2DP || event.hasBluetoothHFP) return "Audio route connected to Bluetooth audio.";
  const output = event.routeOutputs?.[0]?.portName ?? event.routeOutputs?.[0]?.portType;
  if (output) return `Audio route output ${output}.`;
  if (event.suppressedReason) return `Audio route suppressed by ${event.suppressedReason}.`;
  if (event.engineState) return `Audio engine route state ${event.engineState}.`;
  return "Audio route state observed.";
}
