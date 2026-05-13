import Foundation
import CoreLocation
import MapKit

/// Reverse geocoding service that fuses two iOS-native sources:
///
/// 1. `CLGeocoder.reverseGeocodeLocation` → street address + administrative
///    fields + occasional `areasOfInterest`.
/// 2. `MKLocalSearch.Request` with `naturalLanguageQuery = "point of
///    interest"` over a 180 m region (`.includingAll` POI filter) → real
///    POI / business name (e.g. "Starbucks Reserve Roastery") + category +
///    distance to the user.
///
/// The MapKit query style and 180 m region match the sibling native app
/// `proactive-ai-ios` (`LocationMotionPlugin.resolvePOI`) so both
/// platforms surface comparable POI metadata.
///
/// Both lookups run concurrently; the result is merged into a single
/// `PlaceInfo` whose `label` is a deduplicated " | " join of
/// `poi_name | area_of_interest | address` (max 3 segments) — the same
/// composition the native app uses for its `locationLabel`.
///
/// An 11 m-grid LRU cache (cap 200, TTL 24 h) keeps us well under
/// Apple's undocumented `CLGeocoder` rate limit while avoiding stale
/// data on long-running sessions.
public final class GeocodeService {

    public static let shared = GeocodeService()

    public struct PlaceInfo: Sendable {
        public let label: String?
        public let placeName: String?
        public let address: String?
        public let poiName: String?
        public let poiCategory: String?
        public let poiDistanceMeters: Double?
        public let areaOfInterest: String?
        public let areasOfInterest: [String]
        public let thoroughfare: String?
        public let subThoroughfare: String?
        public let locality: String?
        public let subLocality: String?
        public let administrativeArea: String?
        public let postalCode: String?
        public let country: String?
        public let countryCode: String?
        /// `"mapkit+clgeocoder" | "clgeocoder" | "mapkit" | "none"`
        public let source: String
        public let resolvedAt: Date

        public func toDict() -> [String: Any] {
            var dict: [String: Any] = [
                "source": source,
                "resolved_at": Int(resolvedAt.timeIntervalSince1970 * 1000),
            ]
            if let v = label { dict["label"] = v }
            if let v = placeName { dict["place_name"] = v }
            if let v = address { dict["address"] = v }
            if let v = poiName { dict["poi_name"] = v }
            if let v = poiCategory { dict["poi_category"] = v }
            if let v = poiDistanceMeters { dict["poi_distance_m"] = v }
            if let v = areaOfInterest { dict["area_of_interest"] = v }
            if !areasOfInterest.isEmpty { dict["areas_of_interest"] = areasOfInterest }
            if let v = thoroughfare { dict["thoroughfare"] = v }
            if let v = subThoroughfare { dict["sub_thoroughfare"] = v }
            if let v = locality { dict["locality"] = v }
            if let v = subLocality { dict["sub_locality"] = v }
            if let v = administrativeArea { dict["administrative_area"] = v }
            if let v = postalCode { dict["postal_code"] = v }
            if let v = country { dict["country"] = v }
            if let v = countryCode { dict["country_code"] = v }
            return dict
        }
    }

    private struct CacheEntry {
        let info: PlaceInfo
        let storedAt: Date
    }

    private let cacheTTL: TimeInterval = 24 * 60 * 60
    private let cacheCap = 200
    private let poiRegionMeters: CLLocationDistance = 180
    private let lookupTimeoutSeconds: TimeInterval = 3.0

    private let cacheLock = NSLock()
    private var cache: [String: CacheEntry] = [:]
    private var cacheOrder: [String] = []

    private let geocoder = CLGeocoder()
    private let geocoderQueue = DispatchQueue(label: "ai.pin.ambient.geocode", qos: .utility)

    private init() {}

    public func lookup(lat: Double, lng: Double) async -> PlaceInfo {
        let key = cacheKey(lat: lat, lng: lng)
        if let cached = readCache(key) {
            return cached
        }

        let coord = CLLocationCoordinate2D(latitude: lat, longitude: lng)
        let loc = CLLocation(latitude: lat, longitude: lng)

        async let placemarkResult = reverseGeocodeWithTimeout(loc)
        async let poiResult = findNearestPOIWithTimeout(near: loc, coord: coord)

        let placemark = await placemarkResult
        let poi = await poiResult

        let merged = merge(target: loc, placemark: placemark, poi: poi)
        writeCache(key, info: merged)
        return merged
    }

    // MARK: - CLGeocoder

    private func reverseGeocodeWithTimeout(_ loc: CLLocation) async -> CLPlacemark? {
        await withTaskGroup(of: CLPlacemark?.self) { group in
            group.addTask { [weak self] in
                guard let self else { return nil }
                return await self.reverseGeocode(loc)
            }
            group.addTask { [lookupTimeoutSeconds] in
                try? await Task.sleep(nanoseconds: UInt64(lookupTimeoutSeconds * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    private func reverseGeocode(_ loc: CLLocation) async -> CLPlacemark? {
        await withCheckedContinuation { continuation in
            geocoderQueue.async { [geocoder] in
                geocoder.reverseGeocodeLocation(loc, preferredLocale: Locale.current) { placemarks, error in
                    if let error {
                        NSLog("[GeocodeService] CLGeocoder error: %@", error.localizedDescription)
                        continuation.resume(returning: nil)
                        return
                    }
                    continuation.resume(returning: placemarks?.first)
                }
            }
        }
    }

    // MARK: - MapKit POI

    private func findNearestPOIWithTimeout(near loc: CLLocation, coord: CLLocationCoordinate2D) async -> MKMapItem? {
        await withTaskGroup(of: MKMapItem?.self) { group in
            group.addTask { [weak self] in
                guard let self else { return nil }
                return await self.findNearestPOI(near: loc, coord: coord)
            }
            group.addTask { [lookupTimeoutSeconds] in
                try? await Task.sleep(nanoseconds: UInt64(lookupTimeoutSeconds * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    /// Mirrors `proactive-ai-ios/LocationMotionPlugin.nearestMapPOI`:
    /// natural-language POI search over a 180 m square region with the
    /// "include all" POI filter, then pick the named item closest to
    /// the user.
    private func findNearestPOI(near loc: CLLocation, coord: CLLocationCoordinate2D) async -> MKMapItem? {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = "point of interest"
        request.region = MKCoordinateRegion(
            center: coord,
            latitudinalMeters: poiRegionMeters,
            longitudinalMeters: poiRegionMeters
        )
        if #available(iOS 13.0, *) {
            request.pointOfInterestFilter = .includingAll
        }
        return await withCheckedContinuation { continuation in
            MKLocalSearch(request: request).start { response, error in
                if let error {
                    NSLog("[GeocodeService] MKLocalSearch error: %@", error.localizedDescription)
                    continuation.resume(returning: nil)
                    return
                }
                let items = (response?.mapItems ?? []).filter { ($0.name ?? "").isEmpty == false }
                let nearest = items.min { lhs, rhs in
                    let l = lhs.placemark.location.map { loc.distance(from: $0) } ?? .greatestFiniteMagnitude
                    let r = rhs.placemark.location.map { loc.distance(from: $0) } ?? .greatestFiniteMagnitude
                    return l < r
                }
                continuation.resume(returning: nearest)
            }
        }
    }

    // MARK: - Merge

    private func merge(target loc: CLLocation, placemark: CLPlacemark?, poi: MKMapItem?) -> PlaceInfo {
        let source: String
        switch (placemark, poi) {
        case (.some, .some): source = "mapkit+clgeocoder"
        case (.some, .none): source = "clgeocoder"
        case (.none, .some): source = "mapkit"
        case (.none, .none): source = "none"
        }

        let areas = placemark?.areasOfInterest ?? []
        let firstArea = areas.first?.trimmingCharacters(in: .whitespacesAndNewlines)
        let areaOfInterest = (firstArea?.isEmpty == false) ? firstArea : nil

        let poiName = poi?.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let nonEmptyPoiName = (poiName?.isEmpty == false) ? poiName : nil

        let poiCategory: String?
        if #available(iOS 14.0, *), let cat = poi?.pointOfInterestCategory?.rawValue, !cat.isEmpty {
            poiCategory = cat
        } else {
            poiCategory = nil
        }

        let poiDistance: Double?
        if let poiLocation = poi?.placemark.location {
            poiDistance = loc.distance(from: poiLocation)
        } else {
            poiDistance = nil
        }

        let address = formatAddress(placemark)
        let placeName = nonEmptyPoiName ?? areaOfInterest ?? placemark?.name

        // Multi-segment label matches proactive-ai-ios composition:
        // poi_name | area_of_interest | address, deduped, max 3 parts.
        let labelParts = [nonEmptyPoiName, areaOfInterest, address]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let dedupedLabel = dedupePreservingOrder(labelParts).prefix(3).joined(separator: " | ")
        let label = dedupedLabel.isEmpty ? nil : dedupedLabel

        return PlaceInfo(
            label: label,
            placeName: placeName,
            address: address,
            poiName: nonEmptyPoiName,
            poiCategory: poiCategory,
            poiDistanceMeters: poiDistance,
            areaOfInterest: areaOfInterest,
            areasOfInterest: areas,
            thoroughfare: placemark?.thoroughfare,
            subThoroughfare: placemark?.subThoroughfare,
            locality: placemark?.locality,
            subLocality: placemark?.subLocality,
            administrativeArea: placemark?.administrativeArea,
            postalCode: placemark?.postalCode,
            country: placemark?.country,
            countryCode: placemark?.isoCountryCode,
            source: source,
            resolvedAt: Date()
        )
    }

    private func formatAddress(_ placemark: CLPlacemark?) -> String? {
        guard let p = placemark else { return nil }
        let street = [p.subThoroughfare, p.thoroughfare]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        let parts: [String?] = [
            street.isEmpty ? nil : street,
            p.subLocality,
            p.locality,
            p.administrativeArea,
            p.country,
        ]
        let filtered = parts.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                            .filter { !$0.isEmpty }
        let deduped = dedupePreservingOrder(filtered)
        return deduped.isEmpty ? nil : deduped.joined(separator: ", ")
    }

    private func dedupePreservingOrder(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }

    // MARK: - Cache

    private func cacheKey(lat: Double, lng: Double) -> String {
        // ~11 m grid (4 decimals) matches proactive-ai-ios LocationMotionPlugin.
        String(format: "%.4f,%.4f", lat, lng)
    }

    private func readCache(_ key: String) -> PlaceInfo? {
        cacheLock.lock()
        defer { cacheLock.unlock() }
        guard let entry = cache[key] else { return nil }
        if Date().timeIntervalSince(entry.storedAt) > cacheTTL {
            cache.removeValue(forKey: key)
            cacheOrder.removeAll { $0 == key }
            return nil
        }
        if let idx = cacheOrder.firstIndex(of: key) {
            cacheOrder.remove(at: idx)
        }
        cacheOrder.append(key)
        return entry.info
    }

    private func writeCache(_ key: String, info: PlaceInfo) {
        cacheLock.lock()
        defer { cacheLock.unlock() }
        cache[key] = CacheEntry(info: info, storedAt: Date())
        if let idx = cacheOrder.firstIndex(of: key) {
            cacheOrder.remove(at: idx)
        }
        cacheOrder.append(key)
        while cacheOrder.count > cacheCap {
            let evicted = cacheOrder.removeFirst()
            cache.removeValue(forKey: evicted)
        }
    }
}
