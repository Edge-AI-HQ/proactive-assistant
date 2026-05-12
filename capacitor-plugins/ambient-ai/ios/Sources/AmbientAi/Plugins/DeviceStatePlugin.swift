import Foundation
import Capacitor

@objc(DeviceStatePlugin)
public class DeviceStatePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DeviceStatePlugin"
    public let jsName = "DeviceState"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMonitoring", returnType: CAPPluginReturnPromise),
    ]

    private var timer: DispatchSourceTimer?
    private var lastSnapshot: Snapshot?
    private var lastEmittedAt: Date?

    /// Minimum spacing between two emitted events when nothing meaningful changed.
    private let minEmitInterval: TimeInterval = 5 * 60

    private struct Snapshot: Equatable {
        let thermal: String
        let lowPower: Bool
    }

    // MARK: - getState (one-shot)

    @objc func getState(_ call: CAPPluginCall) {
        let snapshot = readSnapshot()
        call.resolve(snapshotToPayload(snapshot))
    }

    // MARK: - startMonitoring

    @objc func startMonitoring(_ call: CAPPluginCall) {
        guard timer == nil else {
            call.resolve()
            return
        }

        let initial = readSnapshot()
        lastSnapshot = initial
        lastEmittedAt = Date()
        notifyListeners("deviceState", data: snapshotToPayload(initial))

        let queue = DispatchQueue(label: "com.pin.device-state.timer", qos: .utility)
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + minEmitInterval, repeating: minEmitInterval)
        t.setEventHandler { [weak self] in
            DispatchQueue.main.async {
                self?.tick()
            }
        }
        t.resume()
        self.timer = t

        print("[DeviceState] Started monitoring")
        call.resolve()
    }

    // MARK: - stopMonitoring

    @objc func stopMonitoring(_ call: CAPPluginCall) {
        timer?.cancel()
        timer = nil
        lastSnapshot = nil
        lastEmittedAt = nil

        print("[DeviceState] Stopped monitoring")
        call.resolve()
    }

    // MARK: - Private

    private func tick() {
        let snapshot = readSnapshot()
        let now = Date()
        if shouldEmit(snapshot: snapshot, now: now) {
            lastSnapshot = snapshot
            lastEmittedAt = now
            notifyListeners("deviceState", data: snapshotToPayload(snapshot))
        }
    }

    private func shouldEmit(snapshot: Snapshot, now: Date) -> Bool {
        guard let last = lastSnapshot, let lastAt = lastEmittedAt else {
            return true
        }
        if snapshot.thermal != last.thermal { return true }
        if snapshot.lowPower != last.lowPower { return true }
        return now.timeIntervalSince(lastAt) >= minEmitInterval
    }

    private func readSnapshot() -> Snapshot {
        let thermal = describe(ProcessInfo.processInfo.thermalState)
        let lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        return Snapshot(thermal: thermal, lowPower: lowPower)
    }

    private func snapshotToPayload(_ snapshot: Snapshot) -> [String: Any] {
        return [
            "thermal": snapshot.thermal,
            "lowPower": snapshot.lowPower,
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
        ]
    }

    private func describe(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }
}
