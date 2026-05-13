import { Geolocation, type Position } from "@capacitor/geolocation";
import { AmbientAi, type PlaceInfo } from "@pin/capacitor-ambient-ai";
import { SIGNAL_KINDS } from "../kinds";
import type { AmbientSource, SourceContext } from "./types";

export interface LocationSourceOptions {
  /**
   * How often to poll `Geolocation.getCurrentPosition`, in milliseconds.
   * Default 5 minutes — long enough that GPS doesn't stay active and the
   * Capacitor bridge isn't logging a position every second, short enough
   * that ambient context stays fresh.
   */
  intervalMs?: number;
  /**
   * Per-sample request timeout passed to `getCurrentPosition`. Shorter
   * than `intervalMs` so a hung fix doesn't pile up overlapping calls.
   */
  timeoutMs?: number;
  /** Min meters between samples to actually emit (filter GPS jitter). */
  minDeltaMeters?: number;
  /**
   * Min meters from the last reverse-geocoded point before issuing a new
   * `Geocoder.reverseGeocode` call. While under this threshold we reuse
   * the cached `PlaceInfo` to avoid hammering CLGeocoder's rate limit.
   */
  minGeocodeDeltaMeters?: number;
  enableHighAccuracy?: boolean;
}

const DEFAULT_OPTS: Required<LocationSourceOptions> = {
  intervalMs: 5 * 60 * 1000,
  timeoutMs: 30 * 1000,
  minDeltaMeters: 25,
  minGeocodeDeltaMeters: 100,
  enableHighAccuracy: true,
};

/**
 * Polled geolocation source: one `Geolocation.getCurrentPosition` per
 * `intervalMs` (default 5 min). We previously used `watchPosition`, but
 * that keeps the GPS chain active full-time and floods the Capacitor JS
 * bridge with per-second updates — far more granularity than ambient
 * context needs.
 *
 * This sits alongside `VisitSource`: visit gives sparse, system-detected
 * place arrivals; location gives periodic coarse fixes when active.
 */
export class LocationSource implements AmbientSource {
  readonly key = "location";
  readonly label = "Geolocation";

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private fetching = false;
  private lastLat = 0;
  private lastLng = 0;
  private lastGeocodedLat: number | null = null;
  private lastGeocodedLng: number | null = null;
  private lastPlace: PlaceInfo | null = null;
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
    this.started = true;
    void this.tick();
    this.intervalId = setInterval(() => {
      void this.tick();
    }, this.opts.intervalMs);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.started = false;
  }

  private async tick(): Promise<void> {
    if (this.fetching) return;
    this.fetching = true;
    try {
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: this.opts.enableHighAccuracy,
        timeout: this.opts.timeoutMs,
      });
      await this.handle(pos);
    } catch (err) {
      console.warn("[LocationSource] getCurrentPosition failed", err);
    } finally {
      this.fetching = false;
    }
  }

  private async handle(pos: Position): Promise<void> {
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

    const { place, placeCached } = await this.resolvePlace(latitude, longitude);

    const placeLabel = place?.label ?? place?.place_name ?? place?.address;
    const summary = placeLabel
      ? `${placeLabel} (${latitude.toFixed(4)}, ${longitude.toFixed(4)} ±${Math.round(accuracy)}m)`
      : `${latitude.toFixed(4)}, ${longitude.toFixed(4)} ±${Math.round(accuracy)}m`;
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
        place: place ?? undefined,
        place_cached: place ? placeCached : undefined,
      },
    });
    this.ctx.onEvent(this.key, summary);
  }

  /**
   * Native `Geocoder.reverseGeocode` is only invoked when we've drifted at
   * least `minGeocodeDeltaMeters` from the last lookup; otherwise we reuse
   * the cached `PlaceInfo`. The native side has its own LRU cache, but
   * this client-side throttle avoids the bridge crossing altogether.
   */
  private async resolvePlace(
    lat: number,
    lng: number,
  ): Promise<{ place: PlaceInfo | null; placeCached: boolean }> {
    if (
      this.lastGeocodedLat !== null &&
      this.lastGeocodedLng !== null &&
      haversineMeters(this.lastGeocodedLat, this.lastGeocodedLng, lat, lng) <
        this.opts.minGeocodeDeltaMeters
    ) {
      return { place: this.lastPlace, placeCached: true };
    }
    try {
      const place = await AmbientAi.geocoder.reverseGeocode({
        latitude: lat,
        longitude: lng,
      });
      this.lastGeocodedLat = lat;
      this.lastGeocodedLng = lng;
      this.lastPlace = place;
      return { place, placeCached: false };
    } catch (err) {
      console.warn("[LocationSource] reverseGeocode failed", err);
      return { place: this.lastPlace, placeCached: this.lastPlace !== null };
    }
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
