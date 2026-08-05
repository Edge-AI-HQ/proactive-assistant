import CoreBluetooth
import Foundation

/// PIN 硬件(MR20 录音器)BLE 会话核心 —— 原样迁移自
/// capacitor-plugins/ambient-ai 的 PinHardwarePlugin(零 Capacitor 依赖)。
/// 扫描/连接/自动重连/state restoration/BLE 音频 → 腾讯 RTASR 推流全在此类;
/// PinHardwareModule 只是 Expo DSL 薄桥。所有方法都必须在主线程调用
/// (CBCentralManager 挂在 main queue,模块桥用 .runOnQueue(.main) 保证)。
public final class PinHardwareController: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    struct Callbacks {
        /// eventName ∈ {pinHardwareState, pinHardwareTranscript}
        let emitEvent: (String, [String: Any]) -> Void
    }

    private let callbacks: Callbacks

    init(callbacks: Callbacks) {
        self.callbacks = callbacks
        super.init()
    }

    private let serviceUUID = CBUUID(string: PinHardwareMR20Protocol.serviceUUID)
    private let audioNotifyUUID = CBUUID(string: PinHardwareMR20Protocol.audioNotifyUUID)
    private let writeUUID = CBUUID(string: PinHardwareMR20Protocol.writeUUID)
    private let commandNotifyUUID = CBUUID(string: PinHardwareMR20Protocol.commandNotifyUUID)

    private var central: CBCentralManager?
    private var discoveredDevices: [UUID: PinHardwareDiscoveredDevice] = [:]
    private var discoveredPeripherals: [UUID: CBPeripheral] = [:]
    private var connectedPeripheral: CBPeripheral?
    private var writeCharacteristic: CBCharacteristic?
    private var isMonitoring = false
    private var isScanning = false
    private var captureRequested = false
    private var captureRunning = false
    private var batteryPercent: Int?
    private var firmwareVersion: String?
    private var status = "idle"

    // ── BLE reconnect / retry ──
    // Some MR20 firmwares occasionally reject the first connect attempt with
    // a transient error. Auto-retry once before surfacing "connect_failed"
    // to the UI so a flaky handshake doesn't force the user to hit rescan.
    private var lastConnectFailurePeripheralId: UUID?
    private var connectRetryScheduled = false
    private var stuckConnectRetryWorkItem: DispatchWorkItem?
    private var restoredConnectionSetupWorkItem: DispatchWorkItem?
    private static let connectRetryDelay: TimeInterval = 1.5
    private static let stuckConnectRetryDelay: TimeInterval = 0.8
    private static let restoredConnectionSetupTimeout: TimeInterval = 2.5

    // ── Preferred device (默认设备) ──
    // The last successfully paired recorder is remembered in UserDefaults so
    // the next session can reconnect without a manual scan+tap. While the
    // toggle is on, `startMonitoring` / poweredOn first try
    // `retrievePeripherals` (works even when the unit isn't advertising to a
    // foreground scan yet) and fall back to scanning; a scan hit on the
    // remembered id also auto-connects. Turning the toggle off forgets the
    // device and returns pairing to fully manual.
    private static let preferredDeviceIdKey = "pinHardware.preferredDeviceId"
    private static let preferredDeviceNameKey = "pinHardware.preferredDeviceName"
    private static let autoReconnectKey = "pinHardware.autoReconnect"

    private var preferredDeviceId: UUID? {
        get { UserDefaults.standard.string(forKey: Self.preferredDeviceIdKey).flatMap(UUID.init(uuidString:)) }
        set {
            if let newValue {
                UserDefaults.standard.set(newValue.uuidString, forKey: Self.preferredDeviceIdKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.preferredDeviceIdKey)
            }
        }
    }

    private var preferredDeviceName: String? {
        get { UserDefaults.standard.string(forKey: Self.preferredDeviceNameKey) }
        set {
            if let newValue {
                UserDefaults.standard.set(newValue, forKey: Self.preferredDeviceNameKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.preferredDeviceNameKey)
            }
        }
    }

    private var autoReconnectEnabled: Bool {
        get { UserDefaults.standard.object(forKey: Self.autoReconnectKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: Self.autoReconnectKey) }
    }

    // ── Background mode + state restoration ──
    // The app declares `bluetooth-central` in UIBackgroundModes so BLE audio
    // keeps flowing with the screen locked. The central carries a restore
    // identifier; when iOS relaunches the app for a BLE event we recreate
    // the manager in load() (restoration only fires if the manager with the
    // same identifier exists at launch) and adopt the restored peripheral in
    // willRestoreState. `sessionActive` in UserDefaults marks "there is a
    // connection worth restoring" so cold user launches don't spin up
    // CoreBluetooth (and its permission prompt) for nothing.
    private static let restoreIdentifier = "pinai.pinHardware.central"
    private static let sessionActiveKey = "pinHardware.sessionActive"
    private static let captureDesiredKey = "pinHardware.captureDesired"

    private var captureDesired: Bool {
        get { UserDefaults.standard.bool(forKey: Self.captureDesiredKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.captureDesiredKey) }
    }

    /// Called from the module's OnCreate (was CAPPlugin.load()): if a BLE
    /// session was live when iOS killed the app, recreate the central so
    /// CoreBluetooth can hand the connection back via willRestoreState.
    func bootstrapRestorationIfNeeded() {
        if UserDefaults.standard.bool(forKey: Self.sessionActiveKey) || captureDesired {
            ensureCentral(showPowerAlert: false)
        }
    }

    // ── Tencent RTASR streaming ──
    // The JS layer mints a short-lived signed URL via
    // POST /api/voice/hardware/tencent-token, then hands it to `startCapture`.
    // The MR20 emits a paced 16 kHz, 32 kbps MP3 byte stream. A new ASR socket
    // must not join that stream mid-frame: after Tencent accepts each socket,
    // we stop/start device recording before forwarding audio so the encoder
    // begins a clean MP3 stream for `voice_format=8`.
    private var asrClient: TencentAsrClient?
    private var asrUrl: URL?
    // Bumped whenever the current client is closed or replaced. Callbacks from
    // a superseded client must not touch current state.
    private var asrClientGeneration = 0
    private var asrState = "idle"
    private var audioBytesReceived = 0
    private var lastAudioAtMs: Int?
    private var lastTranscriptAtMs: Int?
    private static let speakerContextIdKey = "pinHardware.speakerContextId"
    private var speakerContextId: String? {
        get { UserDefaults.standard.string(forKey: Self.speakerContextIdKey) }
        set {
            if let newValue, !newValue.isEmpty {
                UserDefaults.standard.set(newValue, forKey: Self.speakerContextIdKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.speakerContextIdKey)
            }
        }
    }
    private var lastAudioStateEmitAtMs = 0
    private var audioFrameDiagnosticCount = 0
    private static let audioFrameDiagnosticLimit = 3
    private var lastTranscriptDeviceName: String?
    // Interim segment de-dup: speaker mode may revise speaker_id without
    // changing text, so the fingerprint must include attribution as well.
    private var lastInterimFingerprintByIndex: [Int: String] = [:]
    // Device recording is started only after the ASR socket is ready. A
    // generation guard makes every delayed BLE command lose to a later
    // stop/disconnect, so an old restart cannot turn recording back on.
    private var captureCommandGeneration = 0
    private enum CaptureStartPhase {
        case idle
        case stopping
        case waitingToStart
        case starting
        case fallbackStarting
    }

    private var captureStartPhase = CaptureStartPhase.idle
    private var documentedStopFallbackSent = false
    private var awaitingStopAck = false
    private var lastSentCommand: String?
    private var captureRestartWorkItem: DispatchWorkItem?
    private var captureStartFallbackWorkItem: DispatchWorkItem?
    private var captureConfirmationWorkItem: DispatchWorkItem?
    private var captureStopFallbackWorkItem: DispatchWorkItem?
    private static let captureRestartDelay: TimeInterval = 0.35
    private static let captureAckDelay: TimeInterval = 0.8
    private static let captureConfirmationDelay: TimeInterval = 1.0
    private static let captureStopFallbackDelay: TimeInterval = 0.7
    // ISO8601DateFormatter 构造昂贵且线程安全——转录热路径(每秒多次 interim)
    // 复用单例。
    private static let isoFormatter = ISO8601DateFormatter()

    // MARK: - Public method surface (1:1 with the old Capacitor plugin;
    // CAPPluginCall resolve/reject → return value / throws)

    func requestPermissions() -> [String: String] {
        ensureCentral(showPowerAlert: true)
        let result = ["bluetooth": bluetoothPermissionState()]
        emitState()
        return result
    }

    func checkPermissions() -> [String: String] {
        ensureCentral(showPowerAlert: false)
        return ["bluetooth": bluetoothPermissionState()]
    }

    func getState() -> [String: Any] {
        statePayload()
    }

    func startMonitoring() {
        isMonitoring = true
        ensureCentral(showPowerAlert: true)
        if central?.state != .poweredOn {
            status = "waiting_for_bluetooth"
        } else if let peripheral = connectedPeripheral,
                  peripheral.state == .connected,
                  writeCharacteristic == nil {
            // CoreBluetooth restoration can report a transport connection
            // while the characteristic handles needed by the app are gone.
            // Re-discover them, but never let this half-connected state block
            // scanning forever.
            status = "discovering_services"
            peripheral.delegate = self
            peripheral.discoverServices([serviceUUID])
            scheduleRestoredConnectionSetupTimeout(for: peripheral)
        } else if connectedPeripheral?.state != .connected {
            // Symmetric with stopMonitoring's stopScanInternal(). Without
            // this the UI has to know to call startScan separately to make
            // discovery actually happen. Keep scanning until CoreBluetooth
            // confirms a connection, including while a remembered peripheral
            // is reconnecting from the system cache.
            if connectedPeripheral == nil {
                attemptPreferredReconnect()
            }
            startScanInternal()
        }
        emitState()
    }

    func stopMonitoring() {
        isMonitoring = false
        stopScanInternal()
        emitState()
    }

    func startScan() {
        ensureCentral(showPowerAlert: true)
        NSLog(
            "[pin-hardware] scan requested bluetooth=%@ peripheral=%@",
            bluetoothStateName(central?.state),
            peripheralStateName(connectedPeripheral?.state)
        )
        // A cached peripheral is assigned before CoreBluetooth confirms the
        // connection. Only an actual transport connection should stop scan.
        if let peripheral = connectedPeripheral,
           peripheral.state == .connected,
           writeCharacteristic == nil {
            discardUnusableRestoredConnection(peripheral)
            return
        }
        guard connectedPeripheral?.state != .connected else {
            stopScanInternal()
            emitState()
            return
        }
        startScanInternal()
    }

    func stopScan() {
        stopScanInternal()
        emitState()
    }

    struct DeviceNotFoundError: Error {}
    struct AsrUrlRequiredError: Error {}
    struct NotCapturingError: Error {}

    func connect(deviceId: String) throws {
        guard let uuid = UUID(uuidString: deviceId) else {
            throw DeviceNotFoundError()
        }
        let peripheral = discoveredPeripherals[uuid]
            ?? central?.retrievePeripherals(withIdentifiers: [uuid]).first
        guard let peripheral else {
            throw DeviceNotFoundError()
        }

        // An explicit user selection supersedes any delayed retry for the
        // previously active recorder.
        lastConnectFailurePeripheralId = nil
        connectRetryScheduled = false
        discoveredPeripherals[uuid] = peripheral
        let activePeripheral = connectedPeripheral
        let action = pinHardwareConnectionSelectionAction(
            selectedId: uuid,
            activeId: activePeripheral?.identifier,
            activeIsConnecting: activePeripheral?.state == .connecting
        )
        switch action {
        case .restart:
            guard let activePeripheral else { return }
            restartStuckConnection(activePeripheral)
        case .replace:
            guard let activePeripheral else { return }
            replaceActivePeripheral(activePeripheral, with: peripheral)
        case .connect:
            connect(peripheral)
        }
    }

    func disconnect() {
        invalidatePendingCaptureCommands()
        stuckConnectRetryWorkItem?.cancel()
        stuckConnectRetryWorkItem = nil
        restoredConnectionSetupWorkItem?.cancel()
        restoredConnectionSetupWorkItem = nil
        closeAsrClientIfOpen()
        asrUrl = nil
        asrState = "idle"
        if let peripheral = connectedPeripheral {
            central?.cancelPeripheralConnection(peripheral)
        }
        isMonitoring = false
        captureRequested = false
        captureDesired = false
        stopScanInternal()
        connectedPeripheral = nil
        writeCharacteristic = nil
        captureRunning = false
        status = "disconnected"
        updateSessionActiveFlag()
        emitState()
    }

    func startCapture(asrUrl rawAsrUrl: String?) throws {
        guard let raw = rawAsrUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              let parsed = URL(string: raw)
        else {
            status = "asr_unavailable"
            asrState = "error"
            emitState()
            throw AsrUrlRequiredError()
        }
        invalidatePendingCaptureCommands()
        captureRequested = true
        captureDesired = true
        updateSessionActiveFlag()
        audioBytesReceived = 0
        lastAudioAtMs = nil
        lastTranscriptAtMs = nil
        lastAudioStateEmitAtMs = 0
        // Gate the old device stream until Tencent accepts the new socket and
        // beginDeviceCaptureAfterAsrReady() has reset the MR20 encoder.
        captureRunning = false
        asrUrl = parsed
        openAsrClient()
        if writeCharacteristic != nil {
            status = "asr_connecting"
        } else {
            status = "waiting_for_device"
            startScanInternal()
        }
        emitState()
    }

    func stopCapture() {
        invalidatePendingCaptureCommands()
        captureRequested = false
        captureDesired = false
        updateSessionActiveFlag()
        if writeCharacteristic != nil {
            awaitingStopAck = true
            sendCommand(PinHardwareMR20Protocol.realtimeStopCommand)
            scheduleStopFallback(generation: captureCommandGeneration)
        }
        captureRunning = false
        asrClient?.sendEndOfStream()
        closeAsrClientIfOpen()
        asrUrl = nil
        asrState = "idle"
        lastInterimFingerprintByIndex.removeAll()
        audioFrameDiagnosticCount = 0
        status = connectedPeripheral == nil ? "idle" : "connected"
        emitState()
    }

    /// Swap in a freshly minted signed URL after an ASR stream drop. The BLE
    /// connection stays up, but device recording is restarted after provider
    /// readiness so the replacement decoder receives a clean MP3 stream.
    func restartAsr(asrUrl rawAsrUrl: String) throws {
        let raw = rawAsrUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty, let parsed = URL(string: raw) else {
            throw AsrUrlRequiredError()
        }
        guard captureRequested || captureRunning else {
            throw NotCapturingError()
        }
        NSLog("[pin-hardware] restarting asr stream")
        invalidatePendingCaptureCommands()
        // Do not feed the replacement socket from the middle of the current
        // MP3 stream. The provider-ready callback performs BLE&STO → BLE&STA.
        captureRunning = false
        asrUrl = parsed
        openAsrClient()
        status = "asr_connecting"
        emitState()
    }

    func setAutoReconnect(enabled: Bool) {
        autoReconnectEnabled = enabled
        if enabled {
            // Adopt the currently connected device as the new default.
            if let peripheral = connectedPeripheral {
                rememberPreferredDevice(peripheral)
            }
        } else {
            preferredDeviceId = nil
            preferredDeviceName = nil
        }
        emitState()
    }

    func resetSpeakerContext() {
        speakerContextId = nil
        emitState()
    }

    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn, captureDesired || isMonitoring {
            if connectedPeripheral?.state != .connected {
                if connectedPeripheral == nil {
                    attemptPreferredReconnect()
                }
                startScanInternal()
            }
        } else if central.state != .poweredOn {
            invalidatePendingCaptureCommands()
            stopScanInternal()
            status = "waiting_for_bluetooth"
            emitState()
        }
    }

    public func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String
            ?? peripheral.name
            ?? "Unnamed"
        let device = PinHardwareDiscoveredDevice(
            id: peripheral.identifier,
            name: name,
            rssi: RSSI.intValue,
            advertisedServiceUUIDs: Self.serviceUUIDStrings(from: advertisementData)
        )
        guard device.isLikelyRecorder else { return }
        NSLog(
            "[pin-hardware] discovered recorder name=%@ id=%@ rssi=%d",
            device.name,
            device.id.uuidString,
            device.rssi
        )
        discoveredDevices[device.id] = device
        discoveredPeripherals[device.id] = peripheral
        // A queued discovery callback can arrive after didConnect stopped the
        // scan. Do not let a second nearby recorder overwrite the active
        // peripheral's connection/initialization state.
        if connectedPeripheral == nil {
            status = "scanning"
        }
        emitState()

        if connectedPeripheral == nil,
           captureDesired
            || (isMonitoring && autoReconnectEnabled && peripheral.identifier == preferredDeviceId) {
            connect(peripheral)
        }
    }

    public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard connectedPeripheral?.identifier == peripheral.identifier else {
            central.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.delegate = self
        stuckConnectRetryWorkItem?.cancel()
        stuckConnectRetryWorkItem = nil
        restoredConnectionSetupWorkItem?.cancel()
        restoredConnectionSetupWorkItem = nil
        lastConnectFailurePeripheralId = nil
        updateSessionActiveFlag()
        status = "discovering_services"
        stopScanInternal()
        peripheral.discoverServices([serviceUUID])
        emitState()
    }

    public func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard connectedPeripheral?.identifier == peripheral.identifier else { return }
        invalidatePendingCaptureCommands()
        stuckConnectRetryWorkItem?.cancel()
        stuckConnectRetryWorkItem = nil
        restoredConnectionSetupWorkItem?.cancel()
        restoredConnectionSetupWorkItem = nil
        connectedPeripheral = nil
        writeCharacteristic = nil
        captureRunning = false
        updateSessionActiveFlag()
        // One-shot retry for transient flaky handshakes. Only retry if the
        // user still wants a session (captureDesired or isMonitoring) and
        // this isn't already the retry itself.
        let shouldRetry = (captureDesired || isMonitoring)
            && lastConnectFailurePeripheralId != peripheral.identifier
            && !connectRetryScheduled
        if shouldRetry {
            lastConnectFailurePeripheralId = peripheral.identifier
            connectRetryScheduled = true
            status = "connect_retrying"
            emitState()
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.connectRetryDelay) { [weak self] in
                guard let self else { return }
                guard self.lastConnectFailurePeripheralId == peripheral.identifier else { return }
                self.connectRetryScheduled = false
                guard self.captureDesired || self.isMonitoring else { return }
                if let cached = self.discoveredPeripherals[peripheral.identifier] {
                    self.connect(cached)
                } else {
                    self.startScanInternal()
                }
            }
            return
        }
        lastConnectFailurePeripheralId = nil
        status = "connect_failed"
        emitState()
        if isMonitoring || captureDesired {
            startScanInternal()
        }
    }

    public func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard connectedPeripheral?.identifier == peripheral.identifier else { return }
        invalidatePendingCaptureCommands()
        restoredConnectionSetupWorkItem?.cancel()
        restoredConnectionSetupWorkItem = nil
        connectedPeripheral = nil
        writeCharacteristic = nil
        captureRunning = false
        updateSessionActiveFlag()
        status = "disconnected"
        emitState()
        if isMonitoring || captureDesired {
            startScanInternal()
        }
    }

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard connectedPeripheral?.identifier == peripheral.identifier else { return }
        guard error == nil else {
            recoverFromConnectionSetupFailure("service_discovery_failed", peripheral: peripheral)
            return
        }
        let services = peripheral.services ?? []
        guard services.isEmpty == false else {
            recoverFromConnectionSetupFailure("service_not_found", peripheral: peripheral)
            return
        }
        services.forEach { service in
            peripheral.discoverCharacteristics([audioNotifyUUID, writeUUID, commandNotifyUUID], for: service)
        }
    }

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard connectedPeripheral?.identifier == peripheral.identifier else { return }
        guard error == nil else {
            recoverFromConnectionSetupFailure("characteristic_discovery_failed", peripheral: peripheral)
            return
        }
        service.characteristics?.forEach { characteristic in
            if characteristic.uuid == writeUUID {
                writeCharacteristic = characteristic
            }
            if characteristic.uuid == commandNotifyUUID || characteristic.uuid == audioNotifyUUID {
                peripheral.setNotifyValue(true, for: characteristic)
            }
        }

        if writeCharacteristic != nil {
            restoredConnectionSetupWorkItem?.cancel()
            restoredConnectionSetupWorkItem = nil
            status = "connected"
            // Only a fully usable connection (write characteristic found)
            // earns "default device" status — a random BLE unit that failed
            // service discovery must not overwrite the remembered recorder.
            if autoReconnectEnabled {
                rememberPreferredDevice(peripheral)
            }
            // A status reply can describe the pre-reset recording state. Do
            // not let that stale `active=true` race the STOP -> START sequence.
            if !captureRequested {
                sendCommand(PinHardwareMR20Protocol.statusCommand)
            }
            sendCommand(PinHardwareMR20Protocol.batteryCommand)
            sendCommand(PinHardwareMR20Protocol.firmwareCommand)
            if captureRequested {
                if asrState == "ready", !captureRunning {
                    beginDeviceCaptureAfterAsrReady()
                } else if asrState == "error" || asrClient == nil {
                    // The ASR socket may have failed while BLE was offline.
                    // Preserve the error after reconnect so the JS owner can
                    // mint a fresh URL and call restartAsr.
                    asrState = "error"
                    status = "asr_error"
                } else {
                    status = "asr_connecting"
                }
            }
        }
        emitState()
    }

    public func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard connectedPeripheral?.identifier == peripheral.identifier else { return }
        // Data 是 COW 值类型,直接绑定即可——音频路径 ~250 notify/s,
        // 逐帧显式拷贝纯属浪费。
        guard error == nil, let data = characteristic.value else {
            status = "notify_error"
            emitState()
            return
        }
        if characteristic.uuid == commandNotifyUUID {
            handleCommandNotify(String(data: data, encoding: .utf8) ?? "")
        } else if characteristic.uuid == audioNotifyUUID, captureRunning {
            handleAudioNotify(data)
        }
    }

    public func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard connectedPeripheral?.identifier == peripheral.identifier else { return }
        guard characteristic.uuid == writeUUID else { return }
        if let error {
            NSLog("[pin-hardware] command write failed command=%@ error=%@", lastSentCommand ?? "unknown", "\(error)")
        } else {
            NSLog("[pin-hardware] command write acknowledged command=%@", lastSentCommand ?? "unknown")
        }
    }

    private func ensureCentral(showPowerAlert: Bool) {
        if central != nil { return }
        central = CBCentralManager(delegate: self, queue: .main, options: [
            CBCentralManagerOptionShowPowerAlertKey: showPowerAlert,
            CBCentralManagerOptionRestoreIdentifierKey: Self.restoreIdentifier,
        ])
    }

    private func updateSessionActiveFlag() {
        let active = connectedPeripheral != nil || captureDesired
        UserDefaults.standard.set(active, forKey: Self.sessionActiveKey)
    }

    public func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
        NSLog("[pin-hardware] willRestoreState peripherals=%d", restored.count)
        for peripheral in restored {
            peripheral.delegate = self
            discoveredPeripherals[peripheral.identifier] = peripheral
            if peripheral.state == .connected {
                connectedPeripheral = peripheral
                // State restoration may preserve the subscribed
                // characteristics even when no new discovery callback is
                // delivered. Re-adopt those handles immediately so a real
                // restored connection does not look disconnected in the UI.
                for service in peripheral.services ?? [] {
                    for characteristic in service.characteristics ?? [] {
                        if characteristic.uuid == writeUUID {
                            writeCharacteristic = characteristic
                        }
                        if characteristic.uuid == commandNotifyUUID
                            || characteristic.uuid == audioNotifyUUID {
                            peripheral.setNotifyValue(true, for: characteristic)
                        }
                    }
                }
                if writeCharacteristic != nil {
                    NSLog(
                        "[pin-hardware] restored usable connection id=%@",
                        peripheral.identifier.uuidString
                    )
                    status = "connected"
                    if autoReconnectEnabled {
                        rememberPreferredDevice(peripheral)
                    }
                    sendCommand(PinHardwareMR20Protocol.statusCommand)
                    sendCommand(PinHardwareMR20Protocol.batteryCommand)
                    sendCommand(PinHardwareMR20Protocol.firmwareCommand)
                } else {
                    scheduleRestoredConnectionSetupTimeout(for: peripheral)
                }
            } else if peripheral.state == .connecting {
                // CoreBluetooth can restore a connection attempt that no
                // longer has a completion callback after an app reinstall or
                // relaunch. Adopting it makes every later Connect tap a no-op.
                // Cancel it and let the foreground scan produce a fresh
                // peripheral/connection attempt instead.
                NSLog(
                    "[pin-hardware] cancelling stale restored connection id=%@",
                    peripheral.identifier.uuidString
                )
                central.cancelPeripheralConnection(peripheral)
            }
        }
        guard let peripheral = connectedPeripheral else { return }
        if peripheral.state == .connected, writeCharacteristic == nil {
            // Notify subscriptions survive restoration but our cached
            // characteristic handles don't — rediscover to repopulate them.
            // didDiscoverCharacteristicsFor re-issues the status command, so
            // captureRunning re-syncs from the device itself.
            status = "discovering_services"
            peripheral.discoverServices([serviceUUID])
        }
        emitState()
    }

    private func scheduleRestoredConnectionSetupTimeout(for peripheral: CBPeripheral) {
        restoredConnectionSetupWorkItem?.cancel()
        let peripheralId = peripheral.identifier
        let timeout = DispatchWorkItem { [weak self, weak peripheral] in
            guard let self,
                  let peripheral,
                  self.connectedPeripheral?.identifier == peripheralId,
                  self.writeCharacteristic == nil
            else { return }
            self.restoredConnectionSetupWorkItem = nil
            NSLog(
                "[pin-hardware] restored connection setup timed out id=%@",
                peripheralId.uuidString
            )
            self.discardUnusableRestoredConnection(peripheral)
        }
        restoredConnectionSetupWorkItem = timeout
        DispatchQueue.main.asyncAfter(
            deadline: .now() + Self.restoredConnectionSetupTimeout,
            execute: timeout
        )
    }

    private func discardUnusableRestoredConnection(_ peripheral: CBPeripheral) {
        restoredConnectionSetupWorkItem?.cancel()
        restoredConnectionSetupWorkItem = nil
        central?.cancelPeripheralConnection(peripheral)
        connectedPeripheral = nil
        writeCharacteristic = nil
        captureRunning = false
        updateSessionActiveFlag()
        status = "disconnected"
        emitState()
        if isMonitoring || captureDesired {
            startScanInternal()
        }
    }

    private func startScanInternal() {
        ensureCentral(showPowerAlert: true)
        guard central?.state == .poweredOn else {
            status = "waiting_for_bluetooth"
            emitState()
            return
        }
        guard !isScanning else {
            emitState()
            return
        }
        discoveredDevices.removeAll()
        discoveredPeripherals.removeAll()
        // Foreground scan with services=nil so we also see MR20 units whose
        // firmware doesn't advertise the primary service UUID. iOS filters by
        // service UUID at the OS level when we pass a non-empty array, which
        // would make the name-based `isLikelyRecorder` fallback unreachable.
        // Background scanning (which requires the UUID filter) is not the
        // path this plugin uses — pairing is always driven from the
        // management page in the foreground.
        central?.scanForPeripherals(
            withServices: nil,
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
        isScanning = true
        status = "scanning"
        NSLog("[pin-hardware] scan started")
        emitState()
    }

    private func stopScanInternal() {
        central?.stopScan()
        isScanning = false
    }

    private func connect(_ peripheral: CBPeripheral) {
        if let activePeripheral = connectedPeripheral {
            guard activePeripheral.identifier == peripheral.identifier else { return }
            guard activePeripheral.state == .disconnected else {
                emitState()
                return
            }
        }
        connectedPeripheral = peripheral
        status = "connecting"
        updateSessionActiveFlag()
        central?.connect(peripheral, options: [CBConnectPeripheralOptionNotifyOnDisconnectionKey: true])
        emitState()
    }

    private func replaceActivePeripheral(_ activePeripheral: CBPeripheral, with peripheral: CBPeripheral) {
        NSLog(
            "[pin-hardware] replacing active peripheral old=%@ state=%@ selected=%@",
            activePeripheral.identifier.uuidString,
            peripheralStateName(activePeripheral.state),
            peripheral.identifier.uuidString
        )
        invalidatePendingCaptureCommands()
        stuckConnectRetryWorkItem?.cancel()
        stuckConnectRetryWorkItem = nil
        restoredConnectionSetupWorkItem?.cancel()
        restoredConnectionSetupWorkItem = nil
        central?.cancelPeripheralConnection(activePeripheral)
        connectedPeripheral = nil
        writeCharacteristic = nil
        captureRunning = false
        updateSessionActiveFlag()
        connect(peripheral)
    }

    private func restartStuckConnection(_ peripheral: CBPeripheral) {
        stuckConnectRetryWorkItem?.cancel()
        NSLog(
            "[pin-hardware] restarting stuck connection id=%@",
            peripheral.identifier.uuidString
        )
        central?.cancelPeripheralConnection(peripheral)
        connectedPeripheral = nil
        writeCharacteristic = nil
        status = "connect_retrying"
        updateSessionActiveFlag()
        emitState()

        let retry = DispatchWorkItem { [weak self, weak peripheral] in
            guard let self,
                  let peripheral,
                  self.isMonitoring || self.captureDesired
            else { return }
            self.stuckConnectRetryWorkItem = nil
            self.discoveredPeripherals[peripheral.identifier] = peripheral
            self.connect(peripheral)
        }
        stuckConnectRetryWorkItem = retry
        DispatchQueue.main.asyncAfter(
            deadline: .now() + Self.stuckConnectRetryDelay,
            execute: retry
        )
    }

    private func recoverFromConnectionSetupFailure(_ failureStatus: String, peripheral: CBPeripheral) {
        guard connectedPeripheral?.identifier == peripheral.identifier else { return }
        invalidatePendingCaptureCommands()
        writeCharacteristic = nil
        captureRunning = false
        if connectedPeripheral?.identifier == peripheral.identifier {
            connectedPeripheral = nil
        }
        updateSessionActiveFlag()
        status = failureStatus
        emitState()
        if peripheral.state != .disconnected {
            central?.cancelPeripheralConnection(peripheral)
        }
        if isMonitoring || captureDesired {
            startScanInternal()
        }
    }

    private func rememberPreferredDevice(_ peripheral: CBPeripheral) {
        preferredDeviceId = peripheral.identifier
        preferredDeviceName = peripheral.name ?? discoveredDevices[peripheral.identifier]?.name
    }

    /// Try to reconnect the remembered default device without a scan.
    /// Returns true when a connect attempt was issued (caller should skip
    /// the scan fallback), false when there is nothing to reconnect to.
    @discardableResult
    private func attemptPreferredReconnect() -> Bool {
        guard autoReconnectEnabled,
              connectedPeripheral == nil,
              central?.state == .poweredOn,
              let preferredId = preferredDeviceId,
              let central
        else { return false }
        guard let peripheral = central.retrievePeripherals(withIdentifiers: [preferredId]).first else {
            // iOS doesn't know the peripheral (e.g. Bluetooth stack reset).
            // Let the caller fall back to scanning; didDiscover reconnects
            // when the remembered id shows up.
            return false
        }
        discoveredPeripherals[preferredId] = peripheral
        NSLog("[pin-hardware] auto-reconnecting preferred device %@", preferredId.uuidString)
        connect(peripheral)
        return true
    }

    private func invalidatePendingCaptureCommands() {
        captureCommandGeneration += 1
        captureRestartWorkItem?.cancel()
        captureStartFallbackWorkItem?.cancel()
        captureConfirmationWorkItem?.cancel()
        captureStopFallbackWorkItem?.cancel()
        captureRestartWorkItem = nil
        captureStartFallbackWorkItem = nil
        captureConfirmationWorkItem = nil
        captureStopFallbackWorkItem = nil
        captureStartPhase = .idle
        documentedStopFallbackSent = false
        awaitingStopAck = false
    }

    private func cancelPendingCaptureStartCommands() {
        captureRestartWorkItem?.cancel()
        captureStartFallbackWorkItem?.cancel()
        captureConfirmationWorkItem?.cancel()
        captureRestartWorkItem = nil
        captureStartFallbackWorkItem = nil
        captureConfirmationWorkItem = nil
        captureStartPhase = .idle
    }

    private func beginDeviceCaptureAfterAsrReady() {
        guard captureRequested,
              !captureRunning,
              asrState == "ready",
              writeCharacteristic != nil,
              captureStartPhase == .idle
        else { return }

        invalidatePendingCaptureCommands()
        let generation = captureCommandGeneration
        captureStartPhase = .stopping
        status = "capture_starting"
        NSLog("[pin-hardware] resetting device recording before realtime capture")
        sendCommand(PinHardwareMR20Protocol.realtimeStopCommand)
        emitState()

        scheduleResetStopFallback(generation: generation)
    }

    private func scheduleResetStopFallback(generation: Int) {
        let fallback = DispatchWorkItem { [weak self] in
            guard let self,
                  self.captureCommandGeneration == generation,
                  self.captureRequested,
                  !self.captureRunning,
                  self.asrState == "ready",
                  self.writeCharacteristic != nil,
                  self.captureStartPhase == .stopping
            else { return }
            NSLog("[pin-hardware] retrying capture reset with documented stop command")
            self.sendCommand(PinHardwareMR20Protocol.documentedStopCommand)
            self.scheduleDeviceCaptureStart(generation: generation)
        }
        captureRestartWorkItem = fallback
        DispatchQueue.main.asyncAfter(
            deadline: .now() + Self.captureStopFallbackDelay,
            execute: fallback
        )
    }

    private func scheduleDeviceCaptureStart(generation: Int) {
        guard captureCommandGeneration == generation,
              captureRequested,
              !captureRunning,
              asrState == "ready",
              writeCharacteristic != nil,
              captureStartPhase == .stopping
        else { return }

        captureRestartWorkItem?.cancel()
        captureStartPhase = .waitingToStart

        let restart = DispatchWorkItem { [weak self] in
            guard let self,
                  self.captureCommandGeneration == generation,
                  self.captureRequested,
                  !self.captureRunning,
                  self.asrState == "ready",
                  self.writeCharacteristic != nil,
                  self.captureStartPhase == .waitingToStart
            else { return }
            NSLog("[pin-hardware] starting device realtime recording after reset")
            self.captureStartPhase = .starting
            self.sendCommand(PinHardwareMR20Protocol.realtimeStartCommand)
            self.scheduleCaptureStartFallback(generation: generation)
        }
        captureRestartWorkItem = restart
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.captureRestartDelay, execute: restart)
    }

    private func scheduleCaptureStartFallback(generation: Int) {
        let fallback = DispatchWorkItem { [weak self] in
            guard let self,
                  self.captureCommandGeneration == generation,
                  self.captureRequested,
                  !self.captureRunning,
                  self.captureStartPhase == .starting
            else { return }
            self.sendDocumentedStartFallback(generation: generation)
        }
        captureStartFallbackWorkItem = fallback
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.captureAckDelay, execute: fallback)
    }

    private func sendDocumentedStartFallback(generation: Int) {
        guard captureStartPhase == .starting else { return }
        captureStartPhase = .fallbackStarting
        captureStartFallbackWorkItem?.cancel()
        captureStartFallbackWorkItem = nil
        NSLog("[pin-hardware] retrying realtime start with documented command")
        sendCommand(PinHardwareMR20Protocol.documentedStartCommand)

        let confirmation = DispatchWorkItem { [weak self] in
            guard let self,
                  self.captureCommandGeneration == generation,
                  self.captureRequested,
                  !self.captureRunning,
                  self.captureStartPhase == .fallbackStarting
            else { return }
            NSLog("[pin-hardware] device did not confirm realtime recording")
            self.captureStartPhase = .idle
            self.status = "capture_start_failed"
            self.emitState()
        }
        captureConfirmationWorkItem = confirmation
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.captureConfirmationDelay, execute: confirmation)
    }

    private func scheduleStopFallback(generation: Int) {
        let fallback = DispatchWorkItem { [weak self] in
            guard let self,
                  self.captureCommandGeneration == generation,
                  !self.captureRequested,
                  self.awaitingStopAck
            else { return }
            self.sendDocumentedStopFallback()
        }
        captureStopFallbackWorkItem = fallback
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.captureStopFallbackDelay, execute: fallback)
    }

    private func sendDocumentedStopFallback() {
        guard !documentedStopFallbackSent else { return }
        documentedStopFallbackSent = true
        captureStopFallbackWorkItem?.cancel()
        captureStopFallbackWorkItem = nil
        NSLog("[pin-hardware] retrying realtime stop with documented command")
        sendCommand(PinHardwareMR20Protocol.documentedStopCommand)
    }

    private func sendCommand(_ command: String) {
        guard let peripheral = connectedPeripheral,
              let writeCharacteristic,
              let data = command.data(using: .utf8)
        else {
            return
        }
        let writeType: CBCharacteristicWriteType = writeCharacteristic.properties.contains(.write)
            ? .withResponse
            : .withoutResponse
        lastSentCommand = command
        NSLog("[pin-hardware] write command %@", command)
        peripheral.writeValue(data, for: writeCharacteristic, type: writeType)
    }

    private func handleCommandNotify(_ text: String) {
        NSLog("[pin-hardware] device response %@", text)
        switch PinHardwareMR20Protocol.parseDeviceMessage(text) {
        case .battery(let percent):
            batteryPercent = percent
        case .firmware(let version):
            firmwareVersion = version
        case .recording(let active):
            if active {
                guard captureRequested else {
                    captureRunning = false
                    if awaitingStopAck {
                        status = connectedPeripheral == nil ? "idle" : "connected"
                        sendDocumentedStopFallback()
                    } else {
                        // A physical-device STA is an explicit user intent to
                        // start transcription. JS owns token minting and will
                        // call startCapture before audio is sent to Tencent.
                        status = "device_capture_requested"
                    }
                    emitState()
                    return
                }
                if captureStartPhase == .stopping || captureStartPhase == .waitingToStart {
                    // This can be a delayed status response describing the
                    // encoder before our reset. Only a response after START
                    // may confirm the new clean MP3 stream.
                    captureRunning = false
                    status = "capture_starting"
                    emitState()
                    return
                }
                captureRunning = true
                cancelPendingCaptureStartCommands()
                status = asrState == "ready" ? "capturing" : "asr_connecting"
                if asrClient == nil || asrUrl == nil {
                    asrState = "error"
                    status = "asr_error"
                }
            } else {
                captureRunning = false
                if captureRequested, captureStartPhase == .stopping {
                    scheduleDeviceCaptureStart(generation: captureCommandGeneration)
                    status = asrState == "ready" ? "capture_starting" : "asr_connecting"
                } else if captureRequested, captureStartPhase != .idle {
                    status = asrState == "ready" ? "capture_starting" : "asr_connecting"
                } else {
                    awaitingStopAck = false
                    documentedStopFallbackSent = false
                    captureStopFallbackWorkItem?.cancel()
                    captureStopFallbackWorkItem = nil
                    status = "connected"
                }
            }
        case .raw:
            break
        }
        emitState()
    }

    private func emitState() {
        callbacks.emitEvent("pinHardwareState", statePayload())
    }

    private func handleAudioNotify(_ data: Data) {
        if audioFrameDiagnosticCount < Self.audioFrameDiagnosticLimit {
            audioFrameDiagnosticCount += 1
            let prefix = data.prefix(8).map { String(format: "%02x", $0) }.joined()
            NSLog(
                "[pin-hardware] audio frame #%d bytes=%d prefix=%@",
                audioFrameDiagnosticCount,
                data.count,
                prefix
            )
        }
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        audioBytesReceived += data.count
        lastAudioAtMs = nowMs
        // Audio can keep arriving while a replacement WebSocket is opening or
        // after it failed. Count it for diagnostics, but never queue it into a
        // socket until Tencent has explicitly accepted the connection.
        guard asrState == "ready" else {
            if nowMs - lastAudioStateEmitAtMs >= 1_000 {
                lastAudioStateEmitAtMs = nowMs
                emitState()
            }
            return
        }
        guard let client = asrClient, asrUrl != nil else {
            asrState = "error"
            status = "asr_error"
            if nowMs - lastAudioStateEmitAtMs >= 1_000 {
                lastAudioStateEmitAtMs = nowMs
                emitState()
            }
            return
        }
        client.sendAudio(data)
        if nowMs - lastAudioStateEmitAtMs >= 1_000 {
            lastAudioStateEmitAtMs = nowMs
            emitState()
        }
    }

    private func openAsrClient() {
        closeAsrClientIfOpen()
        guard let url = asrUrl else { return }
        lastTranscriptDeviceName = connectedPeripheral?.name
            ?? discoveredDevices[connectedPeripheral?.identifier ?? UUID()]?.name
        lastInterimFingerprintByIndex.removeAll()
        let deviceId = connectedPeripheral?.identifier.uuidString
        let deviceName = lastTranscriptDeviceName
        let generation = asrClientGeneration
        let client = TencentAsrClient(
            url: url,
            callbacks: TencentAsrClient.Callbacks(
                onOpen: { [weak self] in
                    DispatchQueue.main.async {
                        guard let self, self.asrClientGeneration == generation else { return }
                        NSLog("[pin-hardware] tencent asr provider ready")
                        self.asrState = "ready"
                        if self.captureRequested, self.writeCharacteristic != nil {
                            // Always restart the encoder for a new ASR
                            // generation. A WebSocket cannot safely attach to
                            // an already-running Layer III stream mid-frame.
                            self.captureRunning = false
                            self.beginDeviceCaptureAfterAsrReady()
                        } else {
                            self.status = self.captureRequested ? "waiting_for_device" : "connected"
                            self.emitState()
                        }
                    }
                },
                onSpeakerContext: { [weak self] contextId in
                    DispatchQueue.main.async {
                        guard let self, self.asrClientGeneration == generation else { return }
                        self.speakerContextId = contextId
                        self.emitState()
                    }
                },
                onResult: { [weak self] result in
                    DispatchQueue.main.async {
                        guard let self, self.asrClientGeneration == generation else { return }
                        self.handleAsrResult(result, deviceId: deviceId, deviceName: deviceName)
                    }
                },
                onError: { [weak self] error in
                    DispatchQueue.main.async {
                        guard let self, self.asrClientGeneration == generation else { return }
                        let nsError = error as NSError
                        NSLog(
                            "[pin-hardware] asr error domain=%@ code=%d description=%@",
                            nsError.domain,
                            nsError.code,
                            nsError.localizedDescription
                        )
                        self.asrState = "error"
                        self.status = "asr_error"
                        self.emitState()
                    }
                },
                onClose: { [weak self] in
                    DispatchQueue.main.async {
                        guard let self, self.asrClientGeneration == generation else { return }
                        self.asrClient = nil
                        // A server-side close without an error frame still
                        // kills the transcript stream. Surface asr_error so
                        // the JS healer re-mints. stopCapture clears asrUrl
                        // first, so intentional teardown doesn't trip this.
                        if self.captureRequested, self.asrUrl != nil, self.asrState != "error" {
                            self.asrState = "error"
                            self.status = "asr_error"
                            self.emitState()
                        }
                    }
                }
            )
        )
        asrClient = client
        asrState = "connecting"
        client.open()
    }

    private func closeAsrClientIfOpen() {
        // Invalidate callbacks before close can enqueue error/close events.
        // This also prevents a user-initiated stop from being overwritten by
        // an already queued error from the old socket.
        asrClientGeneration += 1
        let client = asrClient
        asrClient = nil
        client?.close()
    }

    private func handleAsrResult(_ result: TencentAsrClient.RecognitionResult,
                                 deviceId: String?,
                                 deviceName: String?) {
        let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        lastTranscriptAtMs = Int(Date().timeIntervalSince1970 * 1000)
        if let contextId = result.speakerContextId, !contextId.isEmpty {
            speakerContextId = contextId
        }
        let fingerprint = result.segments.isEmpty
            ? text
            : result.segments.map {
                "\($0.sentenceId):\($0.speakerId ?? ""):\($0.isFinal):\($0.text)"
            }.joined(separator: "|")
        if !result.isFinal {
            if lastInterimFingerprintByIndex[result.sliceIndex] == fingerprint { return }
            lastInterimFingerprintByIndex[result.sliceIndex] = fingerprint
        } else {
            lastInterimFingerprintByIndex.removeValue(forKey: result.sliceIndex)
        }
        var payload: [String: Any] = [
            "text": text,
            "isFinal": result.isFinal,
            "capturedAt": Self.isoFormatter.string(from: Date()),
            "provider": "tencent_rtasr",
            "sliceIndex": result.sliceIndex,
            "voiceId": result.voiceId,
        ]
        if let deviceId { payload["deviceId"] = deviceId }
        if let deviceName { payload["deviceName"] = deviceName }
        if let start = result.startMs { payload["startMs"] = start }
        if let end = result.endMs { payload["endMs"] = end }
        if let speakerContextId { payload["speakerContextId"] = speakerContextId }
        if result.segments.isEmpty {
            payload["segments"] = [[
                "text": text,
                "isFinal": result.isFinal,
            ]]
        } else {
            payload["segments"] = result.segments.map { segment in
                var item: [String: Any] = [
                    "sentenceId": segment.sentenceId,
                    "text": segment.text,
                    "isFinal": segment.isFinal,
                ]
                if let speakerId = segment.speakerId { item["speakerId"] = speakerId }
                if let startMs = segment.startMs { item["startMs"] = startMs }
                if let endMs = segment.endMs { item["endMs"] = endMs }
                return item
            }
        }
        callbacks.emitEvent("pinHardwareTranscript", payload)
    }

    private func statePayload() -> [String: Any] {
        var payload: [String: Any] = [
            "supported": true,
            "connected": writeCharacteristic != nil && connectedPeripheral?.state == .connected,
            "scanning": isScanning,
            "captureRunning": captureRunning,
            "captureDesired": captureDesired,
            "bluetoothState": bluetoothStateName(central?.state),
            "status": status,
            "asrState": asrState,
            "audioBytesReceived": audioBytesReceived,
            "devices": discoveredDevices.values
                .sorted { lhs, rhs in
                    if lhs.isLikelyRecorder != rhs.isLikelyRecorder {
                        return lhs.isLikelyRecorder && rhs.isLikelyRecorder == false
                    }
                    return lhs.rssi > rhs.rssi
                }
                .map(devicePayload),
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
            "autoReconnect": autoReconnectEnabled,
        ]
        if let preferredId = preferredDeviceId {
            payload["preferredDeviceId"] = preferredId.uuidString
        }
        if let preferredDeviceName {
            payload["preferredDeviceName"] = preferredDeviceName
        }
        if let connectedPeripheral {
            payload["deviceId"] = connectedPeripheral.identifier.uuidString
            payload["deviceName"] = connectedPeripheral.name ?? discoveredDevices[connectedPeripheral.identifier]?.name
        }
        if let batteryPercent {
            payload["batteryPercent"] = batteryPercent
        }
        if let firmwareVersion {
            payload["firmwareVersion"] = firmwareVersion
        }
        if let lastAudioAtMs {
            payload["lastAudioAt"] = lastAudioAtMs
        }
        if let lastTranscriptAtMs {
            payload["lastTranscriptAt"] = lastTranscriptAtMs
        }
        if let speakerContextId {
            payload["speakerContextId"] = speakerContextId
        }
        return payload
    }

    private func devicePayload(_ device: PinHardwareDiscoveredDevice) -> [String: Any] {
        [
            "id": device.id.uuidString,
            "name": device.name,
            "rssi": device.rssi,
            "connected": connectedPeripheral?.identifier == device.id
                && connectedPeripheral?.state == .connected,
        ]
    }

    private func peripheralStateName(_ state: CBPeripheralState?) -> String {
        switch state {
        case .disconnected:
            return "disconnected"
        case .connecting:
            return "connecting"
        case .connected:
            return "connected"
        case .disconnecting:
            return "disconnecting"
        case nil:
            return "none"
        @unknown default:
            return "unknown"
        }
    }

    private func bluetoothPermissionState() -> String {
        switch central?.state {
        case .poweredOn:
            return "granted"
        case .unauthorized:
            return "denied"
        case .poweredOff, .resetting, .unsupported:
            return "denied"
        case .unknown, nil:
            return "prompt"
        @unknown default:
            return "prompt"
        }
    }

    private func bluetoothStateName(_ state: CBManagerState?) -> String {
        switch state {
        case .poweredOn:
            return "poweredOn"
        case .poweredOff:
            return "poweredOff"
        case .resetting:
            return "resetting"
        case .unauthorized:
            return "unauthorized"
        case .unsupported:
            return "unsupported"
        case .unknown, nil:
            return "unknown"
        @unknown default:
            return "unknown"
        }
    }

    private static func serviceUUIDStrings(from advertisementData: [String: Any]) -> [String] {
        let keys = [
            CBAdvertisementDataServiceUUIDsKey,
            CBAdvertisementDataOverflowServiceUUIDsKey,
            CBAdvertisementDataSolicitedServiceUUIDsKey,
        ]
        return keys
            .flatMap { advertisementData[$0] as? [CBUUID] ?? [] }
            .map { $0.uuidString.lowercased() }
            .sorted()
    }
}
