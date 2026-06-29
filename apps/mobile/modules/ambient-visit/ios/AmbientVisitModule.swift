import CoreLocation
import CoreMotion
import ExpoModulesCore
import Foundation
import Intents

/// Expo Module 桥 —— 替代 capacitor VisitMonitorPlugin(CAPPlugin)。CLVisit 监听
/// (durable VisitEventStore 队列 + drain/ack)+ CMMotionActivity 识别 + 反地理编码
/// (GeocodeService,同目录复制自 capacitor)。
///
/// 与原 plugin 的差异(对照 TS 契约 modules/ambient-visit/index.ts):
///   - 不暴露 getCurrentPosition / requestPermissions(location)—— RN 层用 expo-location
///     请求 always 权限,Module 只在已授权前提下 startMonitoring。
///   - focus(requestFocusPermissions/start/stopFocusMonitoring)= 真实现 INFocusStatusCenter
///     (Intents framework;移植自 capacitor NotificationUsagePlugin.emitFocusStatus,并补上
///     OLD 缺的授权请求)。真值需 com.apple.developer.focus-status entitlement——个人 team
///     签不了(本地真机 / 模拟器拿不到真值),仅 CI / 付费 team build 生效;未授权静默不发。
public final class AmbientVisitModule: Module {
  private let store = VisitEventStore()
  private let monitoringEnabledKey = "pin.visitMonitoring.enabled"
  private var locationManager: CLLocationManager?
  private var locationDelegate: VisitLocationDelegate?
  private var activityManager: CMMotionActivityManager?
  private var isMonitoring = false
  private var isRecognizingActivity = false
  private var isMonitoringFocus = false
  private var focusTimer: DispatchSourceTimer?
  private var lastError: String?

  public func definition() -> ModuleDefinition {
    Name("AmbientVisit")

    Events("visit", "activity", "focus")

    OnCreate {
      if UserDefaults.standard.bool(forKey: self.monitoringEnabledKey) {
        do { try self.startMonitoringInternal(reason: "module_load") }
        catch { self.lastError = error.localizedDescription }
      }
    }

    OnDestroy {
      self.stopMonitoringInternal()
      self.activityManager?.stopActivityUpdates()
      self.activityManager = nil
      self.stopFocusInternal()
    }

    AsyncFunction("startMonitoring") {
      try self.startMonitoringInternal(reason: "js")
    }

    AsyncFunction("stopMonitoring") {
      self.stopMonitoringInternal()
      UserDefaults.standard.set(false, forKey: self.monitoringEnabledKey)
    }

    AsyncFunction("drainPendingVisits") { (limit: Int) -> [[String: Any]] in
      try self.store.listPending(limit: limit)
    }

    AsyncFunction("ackPendingVisits") { (ids: [String]) in
      try self.store.ack(ids: ids)
    }

    AsyncFunction("getMonitoringState") { () -> [String: Any] in
      var state = self.store.stats()
      state["authorization"] = self.permissionState(from: self.currentAuthorizationStatus())
      state["nativeMonitoring"] = self.isMonitoring
      state["enabled"] = UserDefaults.standard.bool(forKey: self.monitoringEnabledKey)
      state["lastError"] = self.lastError ?? NSNull()
      return state
    }

    AsyncFunction("startActivityRecognition") {
      try self.startActivityInternal()
    }

    AsyncFunction("stopActivityRecognition") {
      self.activityManager?.stopActivityUpdates()
      self.activityManager = nil
      self.isRecognizingActivity = false
    }

    // Focus 真实现(INFocusStatusCenter / Intents)——见下方 startFocusInternal。
    AsyncFunction("requestFocusPermissions") { (promise: Promise) in
      INFocusStatusCenter.default.requestAuthorization { status in
        promise.resolve(Self.focusAuthString(status))
      }
    }

    AsyncFunction("startFocusMonitoring") {
      self.startFocusInternal()
    }

    AsyncFunction("stopFocusMonitoring") {
      self.stopFocusInternal()
    }
  }

  // MARK: - Visit monitoring

  private func startMonitoringInternal(reason: String) throws {
    if isMonitoring { return }
    guard CLLocationManager.locationServicesEnabled() else {
      throw VisitMonitorError.locationServicesDisabled
    }
    let status = currentAuthorizationStatus()
    guard status == .authorizedAlways else {
      throw VisitMonitorError.alwaysPermissionRequired(permissionState(from: status))
    }
    let delegate = VisitLocationDelegate(
      onVisit: { [weak self] visit in self?.handleVisit(visit) },
      onError: { [weak self] error in self?.lastError = error.localizedDescription }
    )
    let manager = CLLocationManager()
    manager.delegate = delegate
    manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    locationDelegate = delegate
    locationManager = manager
    manager.startMonitoringVisits()
    isMonitoring = true
    lastError = nil
    UserDefaults.standard.set(true, forKey: monitoringEnabledKey)
  }

  private func stopMonitoringInternal() {
    guard isMonitoring else { return }
    locationManager?.stopMonitoringVisits()
    locationManager?.delegate = nil
    locationManager = nil
    locationDelegate = nil
    isMonitoring = false
  }

  private func handleVisit(_ visit: CLVisit) {
    let lat = visit.coordinate.latitude
    let lng = visit.coordinate.longitude
    let departureAt: Any =
      visit.departureDate == Date.distantFuture
        ? NSNull()
        : Int(visit.departureDate.timeIntervalSince1970 * 1000)
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
    do { try store.append(id: id, payload: payload) }
    catch { lastError = error.localizedDescription }
    sendEvent("visit", payload)

    // 反地理编码后补 place 并二次 emit(同 plugin 语义)。
    Task { [weak self] in
      guard let self else { return }
      let place = await GeocodeService.shared.lookup(lat: lat, lng: lng)
      payload["place"] = place.toDict()
      payload["placeStatus"] = "resolved"
      do { try self.store.updatePayload(id: id, payload: payload) }
      catch { self.lastError = error.localizedDescription }
      self.sendEvent("visit", payload)
    }
  }

  // MARK: - Activity recognition

  private func startActivityInternal() throws {
    guard CMMotionActivityManager.isActivityAvailable() else {
      throw VisitMonitorError.activityUnavailable
    }
    if isRecognizingActivity { return }
    let manager = CMMotionActivityManager()
    activityManager = manager
    isRecognizingActivity = true
    manager.startActivityUpdates(to: .main) { [weak self] activity in
      guard let self, let activity else { return }
      self.sendEvent("activity", [
        "type": Self.activityType(from: activity),
        "confidence": Self.confidenceString(activity.confidence),
        "timestamp": Int(Date().timeIntervalSince1970 * 1000),
      ])
    }
  }

  private static func activityType(from activity: CMMotionActivity) -> String {
    if activity.automotive { return "automotive" }
    if activity.cycling { return "cycling" }
    if activity.running { return "running" }
    if activity.walking { return "walking" }
    return "stationary"
  }

  private static func confidenceString(_ confidence: CMMotionActivityConfidence) -> String {
    switch confidence {
    case .high: return "high"
    case .medium: return "medium"
    case .low: return "low"
    @unknown default: return "low"
    }
  }

  // MARK: - Focus monitoring (INFocusStatusCenter)

  /// 真值需 com.apple.developer.focus-status entitlement;未授权静默不发(与
  /// web focus 源注释一致)。无公开变更通知 → 定时轮询,源侧(focus.ts)按值去重。
  private func startFocusInternal() {
    guard INFocusStatusCenter.default.authorizationStatus == .authorized else { return }
    if isMonitoringFocus { return }
    isMonitoringFocus = true
    emitFocusStatus()
    let queue = DispatchQueue(label: "ai.pin.focus.timer", qos: .utility)
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + Self.focusPollInterval, repeating: Self.focusPollInterval)
    timer.setEventHandler { [weak self] in
      DispatchQueue.main.async { self?.emitFocusStatus() }
    }
    timer.resume()
    focusTimer = timer
  }

  private func stopFocusInternal() {
    focusTimer?.cancel()
    focusTimer = nil
    isMonitoringFocus = false
  }

  private func emitFocusStatus() {
    let center = INFocusStatusCenter.default
    guard center.authorizationStatus == .authorized else { return }
    let isFocused = center.focusStatus.isFocused ?? false
    sendEvent("focus", [
      "focused": isFocused,
      "timestamp": Int(Date().timeIntervalSince1970 * 1000),
    ])
  }

  private static let focusPollInterval: TimeInterval = 300

  private static func focusAuthString(_ status: INFocusStatusAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "prompt"
    @unknown default: return "prompt"
    }
  }

  // MARK: - Permission helpers

  private func currentAuthorizationStatus() -> CLAuthorizationStatus {
    CLLocationManager().authorizationStatus
  }

  private func permissionState(from status: CLAuthorizationStatus) -> String {
    switch status {
    case .authorizedAlways: return "always"
    case .authorizedWhenInUse: return "when_in_use"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "prompt"
    @unknown default: return "prompt"
    }
  }

  private func visitId(lat: Double, lng: Double, visit: CLVisit) -> String {
    let arrivalAt = Int(visit.arrivalDate.timeIntervalSince1970 * 1000)
    let departureAt =
      visit.departureDate == Date.distantFuture
        ? "open"
        : String(Int(visit.departureDate.timeIntervalSince1970 * 1000))
    return "visit:\(String(format: "%.4f", lat)):\(String(format: "%.4f", lng)):\(arrivalAt):\(departureAt)"
  }
}

/// CLLocationManagerDelegate helper —— Module 非 NSObject 不能直接 conform。
private final class VisitLocationDelegate: NSObject, CLLocationManagerDelegate {
  private let onVisit: (CLVisit) -> Void
  private let onError: (Error) -> Void

  init(onVisit: @escaping (CLVisit) -> Void, onError: @escaping (Error) -> Void) {
    self.onVisit = onVisit
    self.onError = onError
  }

  func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
    onVisit(visit)
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    onError(error)
  }
}

private enum VisitMonitorError: LocalizedError {
  case locationServicesDisabled
  case alwaysPermissionRequired(String)
  case activityUnavailable

  var errorDescription: String? {
    switch self {
    case .locationServicesDisabled:
      return "location services disabled"
    case .alwaysPermissionRequired(let state):
      return "location permission \(state); always required for visit"
    case .activityUnavailable:
      return "activity recognition not available on this device"
    }
  }
}

/// Durable visit 队列(JSON 文件,app kill 存活)—— 原样迁自 capacitor VisitMonitorPlugin。
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
        "id": id, "payload": payload, "state": "pending",
        "createdAt": now, "updatedAt": now, "deliveryAttempts": 0,
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
    lock.lock(); defer { lock.unlock() }
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
    lock.lock(); defer { lock.unlock() }
    let records = (try? readRecords()) ?? []
    let pending = records.filter { $0["state"] as? String == "pending" }
    let lastNativeVisitAt = records.compactMap { $0["createdAt"] as? Int }.max()
    let lastDrainAt = records.compactMap { $0["lastDeliveredAt"] as? Int }.max()
    return [
      "pendingVisitCount": pending.count,
      "storedVisitCount": records.count,
      "lastNativeVisitAt": lastNativeVisitAt ?? NSNull(),
      "lastDrainAt": lastDrainAt ?? NSNull(),
    ]
  }

  private func mutate(_ block: (inout [[String: Any]]) throws -> Void) throws {
    lock.lock(); defer { lock.unlock() }
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
    let delivered = newestFirst(records.filter { $0["state"] as? String != "pending" }).prefix(deliveredBudget)
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
    (record["updatedAt"] as? Int) ?? (record["createdAt"] as? Int) ?? (record["ackedAt"] as? Int) ?? 0
  }
}

private func nowMillis() -> Int {
  Int(Date().timeIntervalSince1970 * 1000)
}
