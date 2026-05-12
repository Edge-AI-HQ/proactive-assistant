import { Geolocation, type Position } from "@capacitor/geolocation";
import { SIGNAL_KINDS } from "../kinds";
import type { AmbientSource, SourceContext } from "./types";

export interface LocationSourceOptions {
  /** Min meters between samples to actually emit (filter GPS jitter). */
  minDeltaMeters?: number;
  enableHighAccuracy?: boolean;
}

const DEFAULT_OPTS: Required<LocationSourceOptions> = {
  minDeltaMeters: 25,
  enableHighAccuracy: true,
};

/**
 * Continuous geolocation source via the official `@capacitor/geolocation`
 * `watchPosition` API. We filter sub-25m jitter so a stationary device
 * doesn't keep emitting "same place".
 *
 * This sits alongside `VisitSource`: visit gives sparse, system-detected
 * place arrivals; location gives a steady track when active.
 */
export class LocationSource implements AmbientSource {
  readonly key = "location";
  readonly label = "Geolocation";

  private watchId: string | null = null;
  private started = false;
  private lastLat = 0;
  private lastLng = 0;
  private opts: Required<LocationSourceOptions>;

  constructor(
    private ctx: SourceContext,
    opts: LocationSourceOptions = {},
  ) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const perm = await Geolocation.requestPermissions();
    if (perm.location !== "granted") {
      throw new Error(`location permission ${perm.location}`);
    }
    this.watchId = await Geolocation.watchPosition(
      { enableHighAccuracy: this.opts.enableHighAccuracy },
      (pos, err) => {
        if (err || !pos) return;
        this.handle(pos);
      },
    );
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.watchId) {
      await Geolocation.clearWatch({ id: this.watchId });
      this.watchId = null;
    }
    this.started = false;
  }

  private handle(pos: Position): void {
    const { latitude, longitude, accuracy } = pos.coords;
    const delta = haversineMeters(
      this.lastLat,
      this.lastLng,
      latitude,
      longitude,
    );
    if (this.lastLat !== 0 && delta < this.opts.minDeltaMeters) return;
    this.lastLat = latitude;
    this.lastLng = longitude;

    const summary = `${latitude.toFixed(4)}, ${longitude.toFixed(4)} ±${Math.round(accuracy)}m`;
    this.ctx.push({
      kind: SIGNAL_KINDS.location,
      title: "Location update",
      summary,
      occurred_at: new Date(pos.timestamp).toISOString(),
      payload: {
        latitude,
        longitude,
        accuracy,
        altitude: pos.coords.altitude,
        speed: pos.coords.speed,
        heading: pos.coords.heading,
      },
    });
    this.ctx.onEvent(this.key, summary);
  }
}

function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
