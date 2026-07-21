import ExpoModulesCore
import Foundation

/// Expo Module 桥 —— 替代 capacitor PinHardwarePlugin(CAPPlugin)的桥接层。
/// BLE/ASR 核心在 PinHardwareController(原样迁移,零 Capacitor 依赖),
/// 方法面与原插件 1:1。CBCentralManager 挂在 main queue,所有控制器调用
/// 统一 hop 到主线程,与 delegate 回调串行化。
public final class PinHardwareModule: Module {
  private lazy var controller = PinHardwareController(callbacks: .init(
    emitEvent: { [weak self] eventName, payload in
      DispatchQueue.main.async { self?.sendEvent(eventName, payload) }
    }
  ))

  public func definition() -> ModuleDefinition {
    Name("PinHardware")

    Events(
      "pinHardwareState",
      "pinHardwareTranscript"
    )

    OnCreate {
      DispatchQueue.main.async {
        self.controller.bootstrapRestorationIfNeeded()
      }
    }

    AsyncFunction("requestPermissions") { (promise: Promise) in
      DispatchQueue.main.async {
        promise.resolve(self.controller.requestPermissions())
      }
    }

    AsyncFunction("checkPermissions") { (promise: Promise) in
      DispatchQueue.main.async {
        promise.resolve(self.controller.checkPermissions())
      }
    }

    AsyncFunction("getState") { (promise: Promise) in
      DispatchQueue.main.async {
        promise.resolve(self.controller.getState())
      }
    }

    AsyncFunction("startMonitoring") { (promise: Promise) in
      DispatchQueue.main.async {
        self.controller.startMonitoring()
        promise.resolve()
      }
    }

    AsyncFunction("stopMonitoring") { (promise: Promise) in
      DispatchQueue.main.async {
        self.controller.stopMonitoring()
        promise.resolve()
      }
    }

    AsyncFunction("startScan") { (promise: Promise) in
      DispatchQueue.main.async {
        self.controller.startScan()
        promise.resolve()
      }
    }

    AsyncFunction("stopScan") { (promise: Promise) in
      DispatchQueue.main.async {
        self.controller.stopScan()
        promise.resolve()
      }
    }

    AsyncFunction("connect") { (options: [String: Any], promise: Promise) in
      DispatchQueue.main.async {
        guard let deviceId = options["deviceId"] as? String else {
          promise.reject(PinHardwareException("deviceId is required"))
          return
        }
        do {
          try self.controller.connect(deviceId: deviceId)
          promise.resolve()
        } catch {
          promise.reject(PinHardwareException("PIN hardware device is not available"))
        }
      }
    }

    AsyncFunction("disconnect") { (promise: Promise) in
      DispatchQueue.main.async {
        self.controller.disconnect()
        promise.resolve()
      }
    }

    AsyncFunction("startCapture") { (options: [String: Any], promise: Promise) in
      DispatchQueue.main.async {
        do {
          try self.controller.startCapture(asrUrl: options["asrUrl"] as? String)
          promise.resolve()
        } catch {
          promise.reject(PinHardwareException("asrUrl is required"))
        }
      }
    }

    AsyncFunction("stopCapture") { (promise: Promise) in
      DispatchQueue.main.async {
        self.controller.stopCapture()
        promise.resolve()
      }
    }

    AsyncFunction("resetSpeakerContext") { (promise: Promise) in
      DispatchQueue.main.async {
        self.controller.resetSpeakerContext()
        promise.resolve()
      }
    }

    AsyncFunction("setAutoReconnect") { (options: [String: Any], promise: Promise) in
      DispatchQueue.main.async {
        self.controller.setAutoReconnect(enabled: options["enabled"] as? Bool ?? true)
        promise.resolve()
      }
    }

    AsyncFunction("restartAsr") { (options: [String: Any], promise: Promise) in
      DispatchQueue.main.async {
        guard let asrUrl = options["asrUrl"] as? String else {
          promise.reject(PinHardwareException("asrUrl is required"))
          return
        }
        do {
          try self.controller.restartAsr(asrUrl: asrUrl)
          promise.resolve()
        } catch is PinHardwareController.NotCapturingError {
          promise.reject(PinHardwareException("no active capture session"))
        } catch {
          promise.reject(PinHardwareException("asrUrl is required"))
        }
      }
    }
  }
}

/// Capacitor call.reject(msg, code) 的 Expo 等价(promise.reject 自动带栈)。
private final class PinHardwareException: GenericException<String> {
  override var reason: String { param }
}
