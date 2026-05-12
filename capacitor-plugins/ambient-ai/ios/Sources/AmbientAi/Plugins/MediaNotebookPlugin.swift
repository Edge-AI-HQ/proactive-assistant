import Foundation
import Photos
import Capacitor

@objc(MediaNotebookPlugin)
public class MediaNotebookPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MediaNotebookPlugin"
    public let jsName = "MediaNotebook"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMonitoring", returnType: CAPPluginReturnPromise),
    ]

    private var isMonitoring = false
    private var timer: DispatchSourceTimer?
    private var photosGate = CollectionCadenceGate(minimumInterval: 30 * 60)

    // MARK: - Permissions

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
            call.resolve(["photos": self.permissionString(status)])
        }
    }

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        call.resolve(["photos": permissionString(status)])
    }

    // MARK: - Start / Stop

    @objc func startMonitoring(_ call: CAPPluginCall) {
        guard !isMonitoring else {
            call.resolve()
            return
        }
        isMonitoring = true
        readAndEmit()

        let queue = DispatchQueue(label: "com.pin.media-notebook.timer", qos: .utility)
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 30 * 60, repeating: 30 * 60)
        t.setEventHandler { [weak self] in
            DispatchQueue.main.async {
                self?.readAndEmit()
            }
        }
        t.resume()
        self.timer = t

        print("[MediaNotebook] Started monitoring")
        call.resolve()
    }

    @objc func stopMonitoring(_ call: CAPPluginCall) {
        timer?.cancel()
        timer = nil
        isMonitoring = false
        photosGate.reset()

        print("[MediaNotebook] Stopped monitoring")
        call.resolve()
    }

    // MARK: - Private

    private func readAndEmit() {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return }
        guard photosGate.shouldRun() else { return }

        let now = Date()
        let weekAgo = now.addingTimeInterval(-7 * 86400)
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "creationDate > %@ AND creationDate <= %@", weekAgo as NSDate, now as NSDate)
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = 50
        let assets = PHAsset.fetchAssets(with: .image, options: options)
        guard assets.count > 0 else { return }

        var withGPS = 0
        var oldest: Date?
        var newest: Date?
        assets.enumerateObjects { asset, _, _ in
            if asset.location != nil { withGPS += 1 }
            if let d = asset.creationDate {
                if oldest == nil || d < oldest! { oldest = d }
                if newest == nil || d > newest! { newest = d }
            }
        }

        let payload: [String: Any] = [
            "count7d": assets.count,
            "withLocation": withGPS,
            "limitedAccess": status == .limited,
            "oldest": oldest.map { ISO8601DateFormatter().string(from: $0) } ?? NSNull(),
            "newest": newest.map { ISO8601DateFormatter().string(from: $0) } ?? NSNull(),
            "timestamp": Int(now.timeIntervalSince1970 * 1000),
        ]
        notifyListeners("photos", data: payload)
    }

    private func permissionString(_ status: PHAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .limited: return "granted"
        case .notDetermined: return "prompt"
        default: return "denied"
        }
    }
}
