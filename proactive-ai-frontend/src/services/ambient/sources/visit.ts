import {
  AmbientAi,
  type PendingVisit,
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
    if (perm.location !== "always") {
      throw new Error(`location permission ${perm.location}; always required for visit`);
    }
    this.listenerHandle = await AmbientAi.addListener("visit", (event) =>
      void this.handleRealtime(event).catch((err) => {
        console.warn("[VisitSource] realtime visit ingest failed", err);
      }),
    );
    await AmbientAi.visit.startMonitoring();
    this.started = true;
    await this.drainPendingVisits();
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

  async refresh(): Promise<void> {
    if (!this.started) return;
    await this.drainPendingVisits();
  }

  private async drainPendingVisits(): Promise<void> {
    const result = await AmbientAi.visit.drainPendingVisits({ limit: 50 });
    for (const visit of result.visits) {
      try {
        await this.handlePendingVisit(visit);
      } catch (err) {
        console.warn("[VisitSource] pending visit ingest failed", err);
      }
    }
  }

  private async handleRealtime(event: VisitEvent): Promise<void> {
    if (event.placeStatus === "pending") {
      return;
    }
    await this.handle(event);
    if (event.id) {
      await AmbientAi.visit.ackPendingVisits({ ids: [event.id] });
    }
  }

  private async handlePendingVisit(visit: PendingVisit): Promise<void> {
    await this.handle({ ...visit.payload, id: visit.payload.id ?? visit.id });
    await AmbientAi.visit.ackPendingVisits({ ids: [visit.id] });
  }

  private async handle(event: VisitEvent): Promise<void> {
    const isArrival = event.departureAt === null;
    const ts = isArrival ? event.arrivalAt : (event.departureAt ?? event.arrivalAt);
    const lat = event.latitude.toFixed(4);
    const lng = event.longitude.toFixed(4);
    const placeLabel =
      event.place?.label ?? event.place?.place_name ?? event.place?.address;
    const where = placeLabel ?? `${lat}, ${lng}`;
    const summary = isArrival
      ? `Arrived @ ${where} (±${Math.round(event.accuracy)}m)`
      : `Departed @ ${where}`;

    const pushDurable = this.ctx.pushDurable;
    if (!pushDurable) {
      throw new Error("durable visit ingest unavailable");
    }

    await pushDurable({
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
        place: event.place,
        native_id: event.id,
        place_status: event.placeStatus,
      },
      // CLVisit objects emit twice per place (arrival + departure). Keying
      // by (lat,lng,timestamp) keeps both unique while letting retries
      // dedupe.
      dedupe_key: event.id ? `visit:${event.id}` : `visit:${lat}:${lng}:${ts}`,
    });
    this.ctx.onEvent(this.key, summary);
  }
}
