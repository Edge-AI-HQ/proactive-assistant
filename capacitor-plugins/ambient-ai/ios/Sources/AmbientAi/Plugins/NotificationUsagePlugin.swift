import Foundation
import Intents
import UserNotifications
import Capacitor

@objc(NotificationUsagePlugin)
public class NotificationUsagePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NotificationUsagePlugin"
    public let jsName = "NotificationUsage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMonitoring", returnType: CAPPluginReturnPromise),
    ]

    private var isMonitoring = false
    private var timer: DispatchSourceTimer?
    private var notificationGate = CollectionCadenceGate(minimumInterval: 5 * 60)

    // MARK: - Permissions

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in
            call.resolve(["notifications": "granted"])
        }
    }

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status: String
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                status = "granted"
            case .notDetermined:
                status = "prompt"
            default:
                status = "denied"
            }
            call.resolve(["notifications": status])
        }
    }

    // MARK: - Start / Stop

    @objc func startMonitoring(_ call: CAPPluginCall) {
        guard !isMonitoring else {
            call.resolve()
            return
        }
        isMonitoring = true
        readAndEmit()

        let queue = DispatchQueue(label: "com.pin.notification-usage.timer", qos: .utility)
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 5 * 60, repeating: 5 * 60)
        t.setEventHandler { [weak self] in
            DispatchQueue.main.async {
                self?.readAndEmit()
            }
        }
        t.resume()
        self.timer = t

        print("[NotificationUsage] Started monitoring")
        call.resolve()
    }

    @objc func stopMonitoring(_ call: CAPPluginCall) {
        timer?.cancel()
        timer = nil
        isMonitoring = false
        notificationGate.reset()

        print("[NotificationUsage] Stopped monitoring")
        call.resolve()
    }

    // MARK: - Private

    private func readAndEmit() {
        guard notificationGate.shouldRun() else { return }
        emitFocusStatus()
        emitNotificationCounts()
    }

    private func emitFocusStatus() {
        let center = INFocusStatusCenter.default
        guard center.authorizationStatus == .authorized else { return }

        let isFocused = center.focusStatus.isFocused ?? false
        let payload: [String: Any] = [
            "focused": isFocused,
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
        ]
        notifyListeners("focus", data: payload)
    }

    private func emitNotificationCounts() {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized else { return }

            Task { @MainActor in
                let pending = await center.pendingNotificationRequests().count
                let delivered = await center.deliveredNotifications().count
                let payload: [String: Any] = [
                    "pending": pending,
                    "delivered": delivered,
                    "timestamp": Int(Date().timeIntervalSince1970 * 1000),
                ]
                self.notifyListeners("notifications", data: payload)
            }
        }
    }
}
