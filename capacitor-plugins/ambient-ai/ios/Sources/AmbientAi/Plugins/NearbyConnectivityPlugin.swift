import CoreBluetooth
import Foundation
import Capacitor

@objc(NearbyConnectivityPlugin)
public class NearbyConnectivityPlugin: CAPPlugin, CAPBridgedPlugin, CBCentralManagerDelegate {
    public let identifier = "NearbyConnectivityPlugin"
    public let jsName = "NearbyConnectivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMonitoring", returnType: CAPPluginReturnPromise),
    ]

    private var btManager: CBCentralManager?
    private var isMonitoring = false
    private var scanTimer: DispatchSourceTimer?

    private let minEmitInterval: TimeInterval = 10 * 60
    private let scanDuration: TimeInterval = 2

    private var rssiBuckets: [Int: Int] = [:]
    private var sampleCount = 0
    private var lastEmittedAt: Date?

    // MARK: - Permissions

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        if let manager = btManager {
            call.resolve(["bluetooth": manager.state == .poweredOn ? "granted" : "denied"])
            return
        }
        let manager = CBCentralManager(delegate: self, queue: .main, options: [
            CBCentralManagerOptionShowPowerAlertKey: true,
        ])
        self.btManager = manager
        // CBCentralManager initializes asynchronously — resolve with current state.
        // If poweredOn is needed, the caller should check again after a short delay
        // or rely on startMonitoring which waits for poweredOn.
        call.resolve(["bluetooth": manager.state == .poweredOn ? "granted" : "prompt"])
    }

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        if let manager = btManager {
            call.resolve(["bluetooth": manager.state == .poweredOn ? "granted" : "denied"])
        } else {
            call.resolve(["bluetooth": "prompt"])
        }
    }

    // MARK: - Start / Stop

    @objc func startMonitoring(_ call: CAPPluginCall) {
        guard !isMonitoring else {
            call.resolve()
            return
        }
        isMonitoring = true

        if btManager == nil {
            btManager = CBCentralManager(delegate: self, queue: .main, options: [
                CBCentralManagerOptionShowPowerAlertKey: false,
            ])
        }

        scheduleNextScan()
        print("[NearbyConnectivity] Started monitoring")
        call.resolve()
    }

    @objc func stopMonitoring(_ call: CAPPluginCall) {
        isMonitoring = false
        scanTimer?.cancel()
        scanTimer = nil
        btManager?.stopScan()
        rssiBuckets.removeAll()
        sampleCount = 0
        lastEmittedAt = nil

        print("[NearbyConnectivity] Stopped monitoring")
        call.resolve()
    }

    // MARK: - Scan scheduling

    private func scheduleNextScan() {
        guard isMonitoring else { return }
        let queue = DispatchQueue(label: "com.pin.nearby-connectivity.timer", qos: .utility)
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 60, repeating: 60)
        t.setEventHandler { [weak self] in
            DispatchQueue.main.async {
                self?.runScan()
            }
        }
        t.resume()
        self.scanTimer = t
    }

    private func runScan() {
        guard isMonitoring, let manager = btManager, manager.state == .poweredOn else { return }

        let now = Date()
        if let last = lastEmittedAt, now.timeIntervalSince(last) < minEmitInterval {
            return
        }

        rssiBuckets.removeAll()
        sampleCount = 0

        manager.scanForPeripherals(withServices: nil, options: [
            CBCentralManagerScanOptionAllowDuplicatesKey: false,
        ])

        DispatchQueue.main.asyncAfter(deadline: .now() + scanDuration) { [weak self] in
            guard let self else { return }
            manager.stopScan()
            self.lastEmittedAt = Date()

            guard self.sampleCount > 0 else { return }

            let buckets = self.rssiBuckets.keys.sorted()
                .map { "\($0):\(self.rssiBuckets[$0] ?? 0)" }
                .joined(separator: ",")

            let payload: [String: Any] = [
                "samples": self.sampleCount,
                "rssiHistogram": buckets,
                "timestamp": Int(Date().timeIntervalSince1970 * 1000),
            ]
            self.notifyListeners("nearbyBT", data: payload)
        }
    }

    // MARK: - CBCentralManagerDelegate

    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn && isMonitoring {
            scheduleNextScan()
        }
    }

    public func centralManager(_ central: CBCentralManager,
                               didDiscover peripheral: CBPeripheral,
                               advertisementData: [String: Any],
                               rssi RSSI: NSNumber) {
        sampleCount += 1
        let bucket = (RSSI.intValue / 10) * 10
        rssiBuckets[bucket, default: 0] += 1
    }
}
