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
        CAPPluginMethod(name: "getCurrentPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startActivityRecognition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopActivityRecognition", returnType: CAPPluginReturnPromise),
    ]

    private var locationManager: CLLocationManager?
    private var isMonitoring = false
    private var positionCall: CAPPluginCall?
    private var positionManager: CLLocationManager?
    private var activityManager: CMMotionActivityManager?
    private var isRecognizingActivity = false

    // MARK: - Permissions

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        let status: CLAuthorizationStatus
        if #available(iOS 14.0, *) {
            status = CLLocationManager().authorizationStatus
        } else {
            status = CLLocationManager.authorizationStatus()
        }

        switch status {
        case .authorizedWhenInUse, .authorizedAlways:
            call.resolve(["location": "granted"])
        case .denied, .restricted:
            call.resolve(["location": "denied"])
        case .notDetermined:
            let manager = CLLocationManager()
            manager.delegate = self
            objc_setAssociatedObject(self, &AssociatedKeys.permissionCall, call, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
            manager.requestAlwaysAuthorization()
        @unknown default:
            call.resolve(["location": "prompt"])
        }
    }

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        let status: CLAuthorizationStatus
        if #available(iOS 14.0, *) {
            status = CLLocationManager().authorizationStatus
        } else {
            status = CLLocationManager.authorizationStatus()
        }

        let state: String
        switch status {
        case .authorizedWhenInUse, .authorizedAlways:
            state = "granted"
        case .denied, .restricted:
            state = "denied"
        case .notDetermined:
            state = "prompt"
        default:
            state = "prompt"
        }
        call.resolve(["location": state])
    }

    // MARK: - Start / Stop

    @objc func startMonitoring(_ call: CAPPluginCall) {
        if isMonitoring {
            call.resolve()
            return
        }

        let manager = CLLocationManager()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        self.locationManager = manager

        manager.startMonitoringVisits()
        isMonitoring = true

        print("[VisitMonitor] Started monitoring visits")
        call.resolve()
    }

    @objc func stopMonitoring(_ call: CAPPluginCall) {
        guard isMonitoring else {
            call.resolve()
            return
        }

        locationManager?.stopMonitoringVisits()
        locationManager?.delegate = nil
        locationManager = nil
        isMonitoring = false

        print("[VisitMonitor] Stopped monitoring visits")
        call.resolve()
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
        Task {
            let place = await GeocodeService.shared.lookup(lat: lat, lng: lng)
            var payload: [String: Any] = [
                "arrivalAt": Int(visit.arrivalDate.timeIntervalSince1970 * 1000),
                "departureAt": visit.departureDate == Date.distantFuture
                    ? NSNull()
                    : Int(visit.departureDate.timeIntervalSince1970 * 1000),
                "latitude": lat,
                "longitude": lng,
                "accuracy": visit.horizontalAccuracy,
            ]
            payload["place"] = place.toDict()
            print("[VisitMonitor] Visit detected: \(payload)")
            notifyListeners("visit", data: payload)
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard let call = objc_getAssociatedObject(self, &AssociatedKeys.permissionCall) as? CAPPluginCall else {
            return
        }
        objc_setAssociatedObject(self, &AssociatedKeys.permissionCall, nil, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)

        let state: String
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            state = "granted"
        case .denied, .restricted:
            state = "denied"
        default:
            state = "prompt"
        }
        call.resolve(["location": state])
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        print("[VisitMonitor] Location error: \(error.localizedDescription)")
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
}

// MARK: - Associated Keys

private struct AssociatedKeys {
    nonisolated(unsafe) static var permissionCall = "permissionCall"
}
