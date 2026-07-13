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
    private static let connectRetryDelay: TimeInterval = 1.5

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

    /// Called from the module's OnCreate (was CAPPlugin.load()): if a BLE
    /// session was live when iOS killed the app, recreate the central so
    /// CoreBluetooth can hand the connection back via willRestoreState.
    func bootstrapRestorationIfNeeded() {
        if UserDefaults.standard.bool(forKey: Self.sessionActiveKey) {
            ensureCentral(showPowerAlert: false)
        }
    }

    // ── Tencent RTASR streaming ──
    // The JS layer mints a short-lived signed URL via
    // POST /api/voice/hardware/tencent-token, then hands it to `startCapture`.
    // We buffer BLE audio notifies into ~20ms PCM chunks before sending so we
    // don't spam the WS with ~120-byte MTU frames. If `asrUrl` is nil,
    // capture still runs (BLE bytes are discarded) so a signing outage
    // degrades to "hardware connected but no transcript" rather than a
    // full failure.
    //
    // NOTE: assumed audio frame format is 16 kHz mono 16-bit LE PCM (matches
    // Tencent `engine_model_type=16k_zh`, `voice_format=1`). The plugin logs
    // the first N frame sizes so real-device testing will surface a mismatch
    // immediately; adjust `pcmChunkBytes` / model params if the MR20 spec
    // differs.
    private var asrClient: TencentAsrClient?
    private var asrUrl: URL?
    // Bumped on every openAsrClient(). Callbacks from a superseded client
    // (its async close/error lands after a restart already swapped in a new
    // one) must not touch current state — see the generation guards below.
    private var asrClientGeneration = 0
    private var pcmBuffer = Data()
    private static let pcmChunkBytes = 640  // 20ms @ 16kHz mono 16-bit
    private var audioFrameDiagnosticCount = 0
    private static let audioFrameDiagnosticLimit = 3
    private var lastTranscriptDeviceName: String?
    // Interim segment de-dup: Tencent v2 re-sends the same slice_type=0/1
    // frame as text grows. Emit only when the text actually changes to
    // avoid flooding the JS side.
    private var lastInterimTextByIndex: [Int: String] = [:]
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
        } else if connectedPeripheral == nil, !isScanning {
            // Symmetric with stopMonitoring's stopScanInternal(). Without
            // this the UI has to know to call startScan separately to make
            // discovery actually happen. A remembered default device gets a
            // direct reconnect attempt first; fall back to scanning.
            if !attemptPreferredReconnect() {
                startScanInternal()
            }
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
        guard let uuid = UUID(uuidString: deviceId),
              let peripheral = discoveredPeripherals[uuid]
        else {
            throw DeviceNotFoundError()
        }
        connect(peripheral)
    }

    func disconnect() {
        if let peripheral = connectedPeripheral {
            central?.cancelPeripheralConnection(peripheral)
        }
        isMonitoring = false
        captureRequested = false
        stopScanInternal()
        connectedPeripheral = nil
        writeCharacteristic = nil
        captureRunning = false
        status = "disconnected"
        updateSessionActiveFlag()
        emitState()
    }

    func startCapture(asrUrl rawAsrUrl: String?) {
        captureRequested = true
        updateSessionActiveFlag()
        // Optional Tencent RTASR signed URL. When missing, the device still
        // captures over BLE but no transcript is produced — the JS caller
        // will typically retry the mint call before starting again, or the
        // user is falling back to phone-mic in the management page.
        if let raw = rawAsrUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
           !raw.isEmpty,
           let parsed = URL(string: raw) {
            asrUrl = parsed
            openAsrClient()
        } else {
            asrUrl = nil
            closeAsrClientIfOpen()
        }
        if writeCharacteristic != nil {
            sendCommand(PinHardwareMR20Protocol.realtimeStartCommand)
            status = "capture_starting"
        } else {
            status = "waiting_for_device"
            startScanInternal()
        }
        emitState()
    }

    func stopCapture() {
        captureRequested = false
        updateSessionActiveFlag()
        if writeCharacteristic != nil {
            sendCommand(PinHardwareMR20Protocol.realtimeStopCommand)
        }
        captureRunning = false
        flushPcmBuffer(force: true)
        asrClient?.sendEndOfStream()
        closeAsrClientIfOpen()
        asrUrl = nil
        pcmBuffer.removeAll(keepingCapacity: false)
        lastInterimTextByIndex.removeAll()
        audioFrameDiagnosticCount = 0
        status = connectedPeripheral == nil ? "idle" : "connected"
        emitState()
    }

    /// Swap in a freshly minted signed URL after an ASR stream drop, without
    /// touching the BLE session. The JS side owns minting (needs the user's
    /// auth token), the native side owns the socket — this is the seam
    /// between the two for the self-heal loop.
    func restartAsr(asrUrl rawAsrUrl: String) throws {
        let raw = rawAsrUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty, let parsed = URL(string: raw) else {
            throw AsrUrlRequiredError()
        }
        guard captureRequested || captureRunning else {
            throw NotCapturingError()
        }
        NSLog("[pin-hardware] restarting asr stream")
        asrUrl = parsed
        openAsrClient()
        status = captureRunning ? "capturing" : "capture_starting"
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

    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn, captureRequested || isMonitoring {
            if connectedPeripheral == nil, !attemptPreferredReconnect() {
                startScanInternal()
            }
        } else if central.state != .poweredOn {
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
        discoveredDevices[device.id] = device
        discoveredPeripherals[device.id] = peripheral
        status = "scanning"
        emitState()

        if connectedPeripheral == nil,
           captureRequested
            || (isMonitoring && autoReconnectEnabled && peripheral.identifier == preferredDeviceId) {
            connect(peripheral)
        }
    }

    public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        connectedPeripheral = peripheral
        peripheral.delegate = self
        lastConnectFailurePeripheralId = nil
        updateSessionActiveFlag()
        status = "discovering_services"
        stopScanInternal()
        peripheral.discoverServices([serviceUUID])
        emitState()
    }

    public func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        if connectedPeripheral?.identifier == peripheral.identifier {
            connectedPeripheral = nil
        }
        writeCharacteristic = nil
        captureRunning = false
        updateSessionActiveFlag()
        // One-shot retry for transient flaky handshakes. Only retry if the
        // user still wants a session (captureRequested or isMonitoring) and
        // this isn't already the retry itself.
        let shouldRetry = (captureRequested || isMonitoring)
            && lastConnectFailurePeripheralId != peripheral.identifier
            && !connectRetryScheduled
        if shouldRetry {
            lastConnectFailurePeripheralId = peripheral.identifier
            connectRetryScheduled = true
            status = "connect_retrying"
            emitState()
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.connectRetryDelay) { [weak self] in
                guard let self else { return }
                self.connectRetryScheduled = false
                guard self.captureRequested || self.isMonitoring else { return }
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
    }

    public func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        if connectedPeripheral?.identifier == peripheral.identifier {
            connectedPeripheral = nil
        }
        writeCharacteristic = nil
        captureRunning = false
        updateSessionActiveFlag()
        status = "disconnected"
        emitState()
        if isMonitoring || captureRequested {
            startScanInternal()
        }
    }

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil else {
            status = "service_discovery_failed"
            emitState()
            return
        }
        let services = peripheral.services ?? []
        guard services.isEmpty == false else {
            status = "service_not_found"
            emitState()
            return
        }
        services.forEach { service in
            peripheral.discoverCharacteristics([audioNotifyUUID, writeUUID, commandNotifyUUID], for: service)
        }
    }

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard error == nil else {
            status = "characteristic_discovery_failed"
            emitState()
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
            status = "connected"
            // Only a fully usable connection (write characteristic found)
            // earns "default device" status — a random BLE unit that failed
            // service discovery must not overwrite the remembered recorder.
            if autoReconnectEnabled {
                rememberPreferredDevice(peripheral)
            }
            sendCommand(PinHardwareMR20Protocol.statusCommand)
            sendCommand(PinHardwareMR20Protocol.batteryCommand)
            sendCommand(PinHardwareMR20Protocol.firmwareCommand)
            if captureRequested {
                sendCommand(PinHardwareMR20Protocol.realtimeStartCommand)
                status = "capture_starting"
            }
        }
        emitState()
    }

    public func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
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
            if status != "capturing" {
                status = "capturing"
                emitState()
            }
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
        let active = connectedPeripheral != nil || captureRequested
        UserDefaults.standard.set(active, forKey: Self.sessionActiveKey)
    }

    public func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
        NSLog("[pin-hardware] willRestoreState peripherals=%d", restored.count)
        for peripheral in restored {
            peripheral.delegate = self
            discoveredPeripherals[peripheral.identifier] = peripheral
            if peripheral.state == .connected || peripheral.state == .connecting {
                connectedPeripheral = peripheral
            }
        }
        guard let peripheral = connectedPeripheral else { return }
        if peripheral.state == .connected {
            // Notify subscriptions survive restoration but our cached
            // characteristic handles don't — rediscover to repopulate them.
            // didDiscoverCharacteristicsFor re-issues the status command, so
            // captureRunning re-syncs from the device itself.
            status = "discovering_services"
            peripheral.discoverServices([serviceUUID])
        }
        emitState()
    }

    private func startScanInternal() {
        ensureCentral(showPowerAlert: true)
        guard central?.state == .poweredOn else {
            status = "waiting_for_bluetooth"
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
        emitState()
    }

    private func stopScanInternal() {
        central?.stopScan()
        isScanning = false
    }

    private func connect(_ peripheral: CBPeripheral) {
        stopScanInternal()
        connectedPeripheral = peripheral
        status = "connecting"
        updateSessionActiveFlag()
        central?.connect(peripheral, options: [CBConnectPeripheralOptionNotifyOnDisconnectionKey: true])
        emitState()
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
        peripheral.writeValue(data, for: writeCharacteristic, type: writeType)
    }

    private func handleCommandNotify(_ text: String) {
        switch PinHardwareMR20Protocol.parseDeviceMessage(text) {
        case .battery(let percent):
            batteryPercent = percent
        case .firmware(let version):
            firmwareVersion = version
        case .recording(let active):
            captureRunning = active
            status = active ? "capturing" : "connected"
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
        guard asrClient != nil, asrUrl != nil else { return }
        pcmBuffer.append(data)
        flushPcmBuffer(force: false)
    }

    private func flushPcmBuffer(force: Bool) {
        guard let client = asrClient else {
            if force { pcmBuffer.removeAll(keepingCapacity: false) }
            return
        }
        let chunk = Self.pcmChunkBytes
        while pcmBuffer.count >= chunk {
            let out = pcmBuffer.prefix(chunk)
            pcmBuffer.removeSubrange(pcmBuffer.startIndex ..< pcmBuffer.startIndex.advanced(by: chunk))
            client.sendAudio(Data(out))
        }
        if force, !pcmBuffer.isEmpty {
            let tail = pcmBuffer
            pcmBuffer.removeAll(keepingCapacity: false)
            client.sendAudio(tail)
        }
    }

    private func openAsrClient() {
        closeAsrClientIfOpen()
        guard let url = asrUrl else { return }
        lastTranscriptDeviceName = connectedPeripheral?.name
            ?? discoveredDevices[connectedPeripheral?.identifier ?? UUID()]?.name
        lastInterimTextByIndex.removeAll()
        let deviceId = connectedPeripheral?.identifier.uuidString
        let deviceName = lastTranscriptDeviceName
        asrClientGeneration += 1
        let generation = asrClientGeneration
        let client = TencentAsrClient(
            url: url,
            callbacks: TencentAsrClient.Callbacks(
                onResult: { [weak self] result in
                    DispatchQueue.main.async {
                        guard let self, self.asrClientGeneration == generation else { return }
                        self.handleAsrResult(result, deviceId: deviceId, deviceName: deviceName)
                    }
                },
                onError: { [weak self] error in
                    DispatchQueue.main.async {
                        guard let self, self.asrClientGeneration == generation else { return }
                        NSLog("[pin-hardware] asr error: %@", "\(error)")
                        self.status = "asr_error"
                        self.emitState()
                    }
                },
                onClose: { [weak self] in
                    DispatchQueue.main.async {
                        guard let self, self.asrClientGeneration == generation else { return }
                        self.asrClient = nil
                        // A clean server-side close mid-capture (60s URL TTL,
                        // session cutoff without an error frame) still kills
                        // the transcript stream — surface asr_error so the JS
                        // healer re-mints. stopCapture clears asrUrl first, so
                        // intentional teardown doesn't trip this.
                        if self.captureRunning, self.asrUrl != nil, self.status == "capturing" {
                            self.status = "asr_error"
                            self.emitState()
                        }
                    }
                }
            )
        )
        asrClient = client
        client.open()
    }

    private func closeAsrClientIfOpen() {
        asrClient?.close()
        asrClient = nil
    }

    private func handleAsrResult(_ result: TencentAsrClient.RecognitionResult,
                                 deviceId: String?,
                                 deviceName: String?) {
        let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if !result.isFinal {
            if lastInterimTextByIndex[result.sliceIndex] == text { return }
            lastInterimTextByIndex[result.sliceIndex] = text
        } else {
            lastInterimTextByIndex.removeValue(forKey: result.sliceIndex)
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
        payload["segments"] = [[
            "text": text,
            "isFinal": result.isFinal,
        ]]
        callbacks.emitEvent("pinHardwareTranscript", payload)
    }

    private func statePayload() -> [String: Any] {
        var payload: [String: Any] = [
            "supported": true,
            "connected": writeCharacteristic != nil,
            "scanning": isScanning,
            "captureRunning": captureRunning,
            "bluetoothState": bluetoothStateName(central?.state),
            "status": status,
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
        return payload
    }

    private func devicePayload(_ device: PinHardwareDiscoveredDevice) -> [String: Any] {
        [
            "id": device.id.uuidString,
            "name": device.name,
            "rssi": device.rssi,
            "connected": connectedPeripheral?.identifier == device.id,
        ]
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
