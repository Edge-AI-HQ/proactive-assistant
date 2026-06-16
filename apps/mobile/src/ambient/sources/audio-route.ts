/**
 * Audio-route 源（纯 JS：消费 ambient-audio 的 audioState 事件里的路由
 * 字段——车载/蓝牙耳机等高价值上下文）。与 web sources/audio-route.ts
 * 同语义：路由集合变化才推。
 */
import { AmbientAudio, type AudioRoutePort, type AudioStateEvent } from "../../../modules/ambient-audio";
import { type AmbientSource, type SourceContext } from "../types";

const ROUTE_KIND = "device.audio_route";

interface RouteState extends AudioStateEvent {
  routeInputs?: AudioRoutePort[];
  routeOutputs?: AudioRoutePort[];
  hasCarAudio?: boolean;
  hasBluetoothA2DP?: boolean;
  hasBluetoothHFP?: boolean;
}

export function createAudioRouteSource(ctx: SourceContext): AmbientSource {
  let sub: { remove(): void } | null = null;
  let lastKey: string | null = null;

  function handle(event: RouteState): void {
    const inputs = event.routeInputs ?? [];
    const outputs = event.routeOutputs ?? [];
    const inputLabels = inputs.map(routePortLabel).filter(Boolean);
    const outputLabels = outputs.map(routePortLabel).filter(Boolean);
    const key = [...inputLabels, "|", ...outputLabels].join(",");
    if (!key || key === lastKey) return;
    lastKey = key;
    const valuable = event.hasCarAudio === true || event.hasBluetoothA2DP === true || event.hasBluetoothHFP === true;
    const summary = outputLabels.length > 0 ? `audio → ${outputLabels.join(", ")}` : "audio route changed";
    ctx.push({
      kind: ROUTE_KIND,
      title: "Audio route context",
      summary,
      payload: {
        schema_version: "audio_route_context.v1",
        route_inputs: inputs,
        route_outputs: outputs,
        has_car_audio: event.hasCarAudio === true,
        has_bluetooth_a2dp: event.hasBluetoothA2DP === true,
        has_bluetooth_hfp: event.hasBluetoothHFP === true,
        valuable_route: valuable,
      },
    });
    ctx.onEvent("audio_route", summary);
  }

  return {
    key: "audio_route",
    label: "Audio route",
    isStarted: () => sub !== null,
    async start() {
      if (sub) return;
      sub = AmbientAudio.addListener("audioState", handle);
    },
    async stop() {
      sub?.remove();
      sub = null;
      lastKey = null;
    },
  };
}

function routePortLabel(port: AudioRoutePort): string {
  return port.portName || port.portType || port.uid || "";
}
