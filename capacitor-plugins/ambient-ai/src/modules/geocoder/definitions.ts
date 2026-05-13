export interface PlaceInfo {
  /**
   * Multi-segment label composed natively as
   * `poi_name | area_of_interest | address` (deduped, max 3 parts).
   * Mirrors `proactive-ai-ios` `LocationMotionPlugin` semantics so both
   * apps surface comparable POI strings to the LLM.
   */
  label?: string;
  /**
   * Best-effort single-name field: `poi_name ?? area_of_interest ?? placemark.name`.
   * Prefer `label` for display; `place_name` is here for clients that only
   * want a single string.
   */
  place_name?: string;
  address?: string;
  /** MKMapItem.name (POI / business name). */
  poi_name?: string;
  /** MKPointOfInterestCategory raw value (iOS 14+). */
  poi_category?: string;
  /** Distance in meters from the user's coordinate to the matched POI. */
  poi_distance_m?: number;
  /** First entry of `CLPlacemark.areasOfInterest`. */
  area_of_interest?: string;
  /** Full `CLPlacemark.areasOfInterest` list. */
  areas_of_interest?: string[];
  thoroughfare?: string;
  sub_thoroughfare?: string;
  locality?: string;
  sub_locality?: string;
  administrative_area?: string;
  postal_code?: string;
  country?: string;
  country_code?: string;
  /** `"mapkit+clgeocoder" | "clgeocoder" | "mapkit" | "none"` */
  source: string;
  /** Unix epoch ms when the native service resolved this lookup. */
  resolved_at: number;
}

export interface ReverseGeocodeOptions {
  latitude: number;
  longitude: number;
}

export interface GeocoderPlugin {
  reverseGeocode(options: ReverseGeocodeOptions): Promise<PlaceInfo>;
}
