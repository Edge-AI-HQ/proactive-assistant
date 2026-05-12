import {
  AmbientAi,
  type VisitEvent,
} from "@pin/capacitor-ambient-ai";
import type { PluginListenerHandle } from "@capacitor/core";
import { SIGNAL_KINDS } from "../kinds";
import type { AmbientSource, SourceContext } from "./types";

/**
 * Wraps the VisitMonitor native plugin's CLVisit stream (place
 * arrivals/departures). The native plugin only fires when iOS itself
 * decides a visit happened — there's no polling or simulation here.
 *
 * Activity recognition lives in a sibling source (see `activity.ts`)
 * because the two streams have independent start/stop on the same
 * underlying plugin.
 */
export class VisitSource implements AmbientSource {
  readonly key = "visit";
  readonly label = "Place Visits";

  private listenerHandle: PluginListenerHandle | null = null;
  private started = false;

  constructor(private ctx: SourceContext) {}

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const perm = await AmbientAi.visit.requestPermissions();
    if (perm.location !== "granted") {
      throw new Error(`location permission ${perm.location}`);
    }
    this.listenerHandle = await AmbientAi.addListener("visit", (event) =>
      this.handle(event),
    );
    await AmbientAi.visit.startMonitoring();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    try {
      await AmbientAi.visit.stopMonitoring();
    } finally {
      if (this.listenerHandle) {
        await this.listenerHandle.remove();
        this.listenerHandle = null;
      }
      this.started = false;
    }
  }

  private handle(event: VisitEvent): void {
    const isArrival = event.departureAt === null;
    const ts = isArrival ? event.arrivalAt : (event.departureAt ?? event.arrivalAt);
    const lat = event.latitude.toFixed(4);
    const lng = event.longitude.toFixed(4);
    const summary = isArrival
      ? `Arrived @ ${lat}, ${lng} (±${Math.round(event.accuracy)}m)`
      : `Departed @ ${lat}, ${lng}`;

    this.ctx.push({
      kind: SIGNAL_KINDS.visit,
      title: isArrival ? "Place arrival" : "Place departure",
      summary,
      occurred_at: new Date(ts).toISOString(),
      payload: {
        arrival_at: event.arrivalAt,
        departure_at: event.departureAt,
        latitude: event.latitude,
        longitude: event.longitude,
        accuracy: event.accuracy,
        kind: isArrival ? "arrival" : "departure",
      },
      // CLVisit objects emit twice per place (arrival + departure). Keying
      // by (lat,lng,timestamp) keeps both unique while letting retries
      // dedupe.
      dedupe_key: `visit:${lat}:${lng}:${ts}`,
    });
    this.ctx.onEvent(this.key, summary);
  }
}
