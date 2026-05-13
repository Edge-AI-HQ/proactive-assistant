import type {
  GeocoderPlugin,
  PlaceInfo,
  ReverseGeocodeOptions,
} from './definitions';

export class GeocoderWeb implements GeocoderPlugin {
  async reverseGeocode(_options: ReverseGeocodeOptions): Promise<PlaceInfo> {
    return {
      source: 'none',
      resolved_at: Date.now(),
    };
  }
}
