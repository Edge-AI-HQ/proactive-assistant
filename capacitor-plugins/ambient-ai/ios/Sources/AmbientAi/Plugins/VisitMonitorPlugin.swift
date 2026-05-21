import Foundation
import CoreLocation
import CoreMotion
import Capacitor

@objc(VisitMonitorPlugin)
public class VisitMonitorPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "VisitMonitorPlugin"
    public let jsName = "VisitMonitor"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drainPendingVisits", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ackPendingVisits", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getMonitoringState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startActivityRecognition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopActivityRecognition", returnType: CAPPluginReturnPromise),
    ]

    private let monitoringEnabledKey = "pin.visitMonitoring.enabled"
    private let store = VisitEventStore()
    private var locationManager: CLLocationManager?
    private var permissionManager: CLLocationManager?
    private var isMonitoring = false
    private var lastError: String?
    private var positionCall: CAPPluginCall?
    private var positionManager: CLLocationManager?
    private var activityManager: CMMotionActivityManager?
    private var isRecognizingActivity = false

    public override func load() {
        if UserDefaults.standard.bool(forKey: monitoringEnabledKey) {
            do {
                try startMonitoringInternal(reason: "plugin_load")
            } catch {
                lastError = error.localizedDescription
                print("[VisitMonitor] Auto-resume failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Permissions

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        let status = currentAuthorizationStatus()

        switch status {
        case .authorizedAlways:
            call.resolve(["location": "always"])
        case .authorizedWhenInUse, .notDetermined:
            let manager = CLLocationManager()
            manager.delegate = self
            permissionManager = manager
            objc_setAssociatedObject(self, &AssociatedKeys.permissionCall, call, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
            manager.requestAlwaysAuthorization()
        default:
            call.resolve(["location": permissionState(from: status)])
        }
    }

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(["location": permissionState(from: currentAuthorizationStatus())])
    }

    // MARK: - Start / Stop

    @objc func startMonitoring(_ call: CAPPluginCall) {
        do {
            try startMonitoringInternal(reason: "js")
            call.resolve()
        } catch {
            lastError = error.localizedDescription
            call.reject(error.localizedDescription, "VISIT_MONITOR_ERROR")
        }
    }

    @objc func stopMonitoring(_ call: CAPPluginCall) {
        stopMonitoringInternal()
        UserDefaults.standard.set(false, forKey: monitoringEnabledKey)
        call.resolve()
    }

    @objc func drainPendingVisits(_ call: CAPPluginCall) {
        let limit = call.getInt("limit") ?? 50
        do {
            call.resolve(["visits": try store.listPending(limit: limit)])
        } catch {
            lastError = error.localizedDescription
            call.reject(error.localizedDescription, "VISIT_STORE_ERROR")
        }
    }

    @objc func ackPendingVisits(_ call: CAPPluginCall) {
        let ids = call.getArray("ids", String.self) ?? []
        do {
            try store.ack(ids: ids)
            call.resolve()
        } catch {
            lastError = error.localizedDescription
            call.reject(error.localizedDescription, "VISIT_STORE_ERROR")
        }
    }

    @objc func getMonitoringState(_ call: CAPPluginCall) {
        var state = store.stats()
        state["authorization"] = permissionState(from: currentAuthorizationStatus())
        state["nativeMonitoring"] = isMonitoring
        state["enabled"] = UserDefaults.standard.bool(forKey: monitoringEnabledKey)
        if let lastError {
            state["lastError"] = lastError
        } else {
            state["lastError"] = NSNull()
        }
        call.resolve(state)
    }

    private func startMonitoringInternal(reason: String) throws {
        if isMonitoring { return }
        guard CLLocationManager.locationServicesEnabled() else {
            throw VisitMonitorError.locationServicesDisabled
        }

        let status = currentAuthorizationStatus()
        guard status == .authorizedAlways else {
            throw VisitMonitorError.alwaysPermissionRequired(permissionState(from: status))
        }

        let manager = CLLocationManager()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        self.locationManager = manager
        manager.startMonitoringVisits()
        isMonitoring = true
        lastError = nil
        UserDefaults.standard.set(true, forKey: monitoringEnabledKey)

        print("[VisitMonitor] Started monitoring visits (\(reason))")
    }

    private func stopMonitoringInternal() {
        guard isMonitoring else { return }

        locationManager?.stopMonitoringVisits()
        locationManager?.delegate = nil
        locationManager = nil
        isMonitoring = false

        print("[VisitMonitor] Stopped monitoring visits")
    }

    // MARK: - Get Current Position

    @objc func getCurrentPosition(_ call: CAPPluginCall) {
        positionCall = call

        let pm = CLLocationManager()
        pm.delegate = self
        pm.desiredAccuracy = kCLLocationAccuracyHundredMeters
        self.positionManager = pm
        pm.startUpdatingLocation()
    }

    // MARK: - Activity Recognition

    @objc func startActivityRecognition(_ call: CAPPluginCall) {
        guard CMMotionActivityManager.isActivityAvailable() else {
            call.reject("Activity recognition not available on this device", "NOT_AVAILABLE")
            return
        }
        guard !isRecognizingActivity else {
            call.resolve()
            return
        }

        let manager = CMMotionActivityManager()
        self.activityManager = manager
        isRecognizingActivity = true

        manager.startActivityUpdates(to: .main) { [weak self] activity in
            guard let self, let activity else { return }
            let type = self.activityType(from: activity)
            let payload: [String: Any] = [
                "type": type,
                "confidence": self.confidenceString(activity.confidence),
                "timestamp": Int(Date().timeIntervalSince1970 * 1000),
            ]
            self.notifyListeners("activity", data: payload)
        }

        print("[VisitMonitor] Started activity recognition")
        call.resolve()
    }

    @objc func stopActivityRecognition(_ call: CAPPluginCall) {
        activityManager?.stopActivityUpdates()
        activityManager = nil
        isRecognizingActivity = false
        print("[VisitMonitor] Stopped activity recognition")
        call.resolve()
    }

    private func activityType(from activity: CMMotionActivity) -> String {
        if activity.automotive { return "automotive" }
        if activity.cycling { return "cycling" }
        if activity.running { return "running" }
        if activity.walking { return "walking" }
        return "stationary"
    }

    private func confidenceString(_ confidence: CMMotionActivityConfidence) -> String {
        switch confidence {
        case .high: return "high"
        case .medium: return "medium"
        case .low: return "low"
        @unknown default: return "low"
        }
    }

    // MARK: - CLLocationManagerDelegate

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last, let call = positionCall else { return }
        positionCall = nil
        positionManager?.stopUpdatingLocation()
        positionManager?.delegate = nil
        positionManager = nil
        let lat = loc.coordinate.latitude
        let lng = loc.coordinate.longitude
        Task {
            let place = await GeocodeService.shared.lookup(lat: lat, lng: lng)
            var payload: [String: Any] = [
                "latitude": lat,
                "longitude": lng,
                "accuracy": loc.horizontalAccuracy,
                "altitude": loc.altitude,
                "timestamp": Int(loc.timestamp.timeIntervalSince1970 * 1000),
            ]
            payload["place"] = place.toDict()
            call.resolve(payload)
        }
    }

    public func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        let lat = visit.coordinate.latitude
        let lng = visit.coordinate.longitude
        let departureAt: Any
        if visit.departureDate == Date.distantFuture {
            departureAt = NSNull()
        } else {
            departureAt = Int(visit.departureDate.timeIntervalSince1970 * 1000)
        }
        let id = visitId(lat: lat, lng: lng, visit: visit)
        var payload: [String: Any] = [
            "id": id,
            "arrivalAt": Int(visit.arrivalDate.timeIntervalSince1970 * 1000),
            "departureAt": departureAt,
            "latitude": lat,
            "longitude": lng,
            "accuracy": visit.horizontalAccuracy,
            "placeStatus": "pending",
        ]

        do {
            try store.append(id: id, payload: payload)
        } catch {
            lastError = error.localizedDescription
            print("[VisitMonitor] Failed to persist visit: \(error.localizedDescription)")
        }
        notifyListeners("visit", data: payload)

        Task {
            let place = await GeocodeService.shared.lookup(lat: lat, lng: lng)
            payload["place"] = place.toDict()
            payload["placeStatus"] = "resolved"
            do {
                try store.updatePayload(id: id, payload: payload)
            } catch {
                self.lastError = error.localizedDescription
                print("[VisitMonitor] Failed to update visit place: \(error.localizedDescription)")
            }
            print("[VisitMonitor] Visit detected: \(payload)")
            notifyListeners("visit", data: payload)
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard let call = objc_getAssociatedObject(self, &AssociatedKeys.permissionCall) as? CAPPluginCall else {
            return
        }
        objc_setAssociatedObject(self, &AssociatedKeys.permissionCall, nil, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)

        permissionManager = nil
        call.resolve(["location": permissionState(from: manager.authorizationStatus)])
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        print("[VisitMonitor] Location error: \(error.localizedDescription)")
        lastError = error.localizedDescription
        if manager === positionManager {
            positionManager?.stopUpdatingLocation()
            positionManager?.delegate = nil
            positionManager = nil
        }
        if let call = positionCall {
            positionCall = nil
            call.reject(error.localizedDescription, "LOCATION_ERROR")
        }
    }

    private func currentAuthorizationStatus() -> CLAuthorizationStatus {
        if #available(iOS 14.0, *) {
            return CLLocationManager().authorizationStatus
        }
        return CLLocationManager.authorizationStatus()
    }

    private func permissionState(from status: CLAuthorizationStatus) -> String {
        switch status {
        case .authorizedAlways:
            return "always"
        case .authorizedWhenInUse:
            return "when_in_use"
        case .denied:
            return "denied"
        case .restricted:
            return "restricted"
        case .notDetermined:
            return "prompt"
        @unknown default:
            return "prompt"
        }
    }

    private func visitId(lat: Double, lng: Double, visit: CLVisit) -> String {
        let arrivalAt = Int(visit.arrivalDate.timeIntervalSince1970 * 1000)
        let departureAt = visit.departureDate == Date.distantFuture
            ? "open"
            : String(Int(visit.departureDate.timeIntervalSince1970 * 1000))
        return "visit:\(String(format: "%.4f", lat)):\(String(format: "%.4f", lng)):\(arrivalAt):\(departureAt)"
    }
}

// MARK: - Associated Keys

private struct AssociatedKeys {
    nonisolated(unsafe) static var permissionCall = "permissionCall"
}

private enum VisitMonitorError: LocalizedError {
    case locationServicesDisabled
    case alwaysPermissionRequired(String)

    var errorDescription: String? {
        switch self {
        case .locationServicesDisabled:
            return "location services disabled"
        case .alwaysPermissionRequired(let state):
            return "location permission \(state); always required for visit"
        }
    }
}

private final class VisitEventStore {
    private let maxStoredRecords = 1_000
    private let maxDeliveredRecords = 500
    private let fileURL: URL
    private let lock = NSLock()

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("AmbientAi", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        fileURL = base.appendingPathComponent("visit-events.json")
    }

    func append(id: String, payload: [String: Any]) throws {
        try mutate { records in
            if let idx = records.firstIndex(where: { $0["id"] as? String == id }) {
                records[idx]["payload"] = payload
                records[idx]["state"] = "pending"
                records[idx]["updatedAt"] = nowMillis()
                return
            }
            let now = nowMillis()
            records.append([
                "id": id,
                "payload": payload,
                "state": "pending",
                "createdAt": now,
                "updatedAt": now,
                "deliveryAttempts": 0,
            ])
        }
    }

    func updatePayload(id: String, payload: [String: Any]) throws {
        try mutate { records in
            guard let idx = records.firstIndex(where: { $0["id"] as? String == id }) else { return }
            records[idx]["payload"] = payload
            records[idx]["updatedAt"] = nowMillis()
        }
    }

    func listPending(limit: Int) throws -> [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        let boundedLimit = max(1, min(limit, 200))
        var records = try readRecords()
        var visits: [[String: Any]] = []
        let now = nowMillis()

        for idx in records.indices {
            guard records[idx]["state"] as? String == "pending" else { continue }
            records[idx]["deliveryAttempts"] = (records[idx]["deliveryAttempts"] as? Int ?? 0) + 1
            records[idx]["lastDeliveredAt"] = now
            if let id = records[idx]["id"] as? String,
               let payload = records[idx]["payload"] as? [String: Any] {
                visits.append(["id": id, "payload": payload])
            }
            if visits.count >= boundedLimit { break }
        }

        try writeRecords(records)
        return visits
    }

    func ack(ids: [String]) throws {
        let idSet = Set(ids)
        try mutate { records in
            let now = nowMillis()
            for idx in records.indices where idSet.contains(records[idx]["id"] as? String ?? "") {
                records[idx]["state"] = "delivered"
                records[idx]["updatedAt"] = now
                records[idx]["ackedAt"] = now
            }
        }
    }

    func stats() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let records = (try? readRecords()) ?? []
        let pending = records.filter { $0["state"] as? String == "pending" }
        let lastNativeVisitAt = records.compactMap { $0["createdAt"] as? Int }.max()
        let lastDrainAt = records.compactMap { $0["lastDeliveredAt"] as? Int }.max()
        var result: [String: Any] = [
            "pendingVisitCount": pending.count,
            "storedVisitCount": records.count,
        ]
        if let lastNativeVisitAt {
            result["lastNativeVisitAt"] = lastNativeVisitAt
        } else {
            result["lastNativeVisitAt"] = NSNull()
        }
        if let lastDrainAt {
            result["lastDrainAt"] = lastDrainAt
        } else {
            result["lastDrainAt"] = NSNull()
        }
        return result
    }

    private func mutate(_ block: (inout [[String: Any]]) throws -> Void) throws {
        lock.lock()
        defer { lock.unlock() }
        var records = try readRecords()
        try block(&records)
        try writeRecords(records)
    }

    private func readRecords() throws -> [[String: Any]] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
        let data = try Data(contentsOf: fileURL)
        guard !data.isEmpty else { return [] }
        return (try JSONSerialization.jsonObject(with: data)) as? [[String: Any]] ?? []
    }

    private func writeRecords(_ records: [[String: Any]]) throws {
        let data = try JSONSerialization.data(withJSONObject: prune(records))
        try data.write(to: fileURL, options: .atomic)
    }

    private func prune(_ records: [[String: Any]]) -> [[String: Any]] {
        guard records.count > maxStoredRecords || deliveredCount(records) > maxDeliveredRecords else {
            return records
        }

        let pending = records.filter { $0["state"] as? String == "pending" }
        let deliveredBudget = max(0, min(maxDeliveredRecords, maxStoredRecords - pending.count))
        let delivered = newestFirst(records.filter { $0["state"] as? String != "pending" })
            .prefix(deliveredBudget)

        return oldestFirst(Array(pending) + Array(delivered))
    }

    private func deliveredCount(_ records: [[String: Any]]) -> Int {
        records.filter { $0["state"] as? String != "pending" }.count
    }

    private func newestFirst(_ records: [[String: Any]]) -> [[String: Any]] {
        records.sorted { recordTimestamp($0) > recordTimestamp($1) }
    }

    private func oldestFirst(_ records: [[String: Any]]) -> [[String: Any]] {
        records.sorted { recordTimestamp($0) < recordTimestamp($1) }
    }

    private func recordTimestamp(_ record: [String: Any]) -> Int {
        (record["updatedAt"] as? Int)
            ?? (record["createdAt"] as? Int)
            ?? (record["ackedAt"] as? Int)
            ?? 0
    }
}

private func nowMillis() -> Int {
    Int(Date().timeIntervalSince1970 * 1000)
}
