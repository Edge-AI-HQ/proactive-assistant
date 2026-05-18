import AVFoundation
import Foundation
import os
import SoundAnalysis

private let soundLogger = Logger(subsystem: "ai.pin.ambient-ai", category: "sound-classification")

struct SoundClassificationFrame {
    struct Entry {
        let label: String
        let confidence: Double
    }

    let topLabel: String
    let topConfidence: Double
    let top: [Entry]
    let timestamp: Date
}

struct SoundClassificationDiagnostics {
    let engineState: AudioEngineState
    let lastFrameAt: Date?
    let lastError: String?
    let restartCount: Int
    let capturePipelineRunning: Bool
}

protocol AudioRecordingSink: AnyObject {
    func recordingDidStart(
        format: AVAudioFormat,
        preRollPCM: Data,
        preRollDurationMs: Int
    )
    func recordingDidReceive(buffer: AVAudioPCMBuffer)
}

final class SoundClassificationService {
    var onFrame: ((SoundClassificationFrame) -> Void)?
    var onSpeechFrame: (() -> Void)?
    var onSpeechBurst: ((Double, String) -> Void)?
    var onOtherAudioDetected: (() -> Void)?
    var onInterruptionBegan: (() -> Void)?
    var onInterruptionEnded: (() -> Void)?
    var onError: ((String, String) -> Void)?
    var onAnalyzerFailed: ((String) -> Void)?

    private let lock = NSLock()
    private let analysisQueue = DispatchQueue(label: "ai.pin.ambient-ai.sound-analysis", qos: .utility)
    private let preRollBuffer = AudioPreRollBuffer()

    private var engine: AVAudioEngine?
    private var analyzer: SNAudioStreamAnalyzer?
    private var observer: ClassificationObserver?
    private weak var sink: AudioRecordingSink?
    private var sinkActive = false
    private var engineState: AudioEngineState = .stopped
    private var lastFrameAt: Date?
    private var lastError: String?
    private var restartCount = 0
    private var consecutiveSpeechCount = 0
    private var lastFallbackBurstAt: Date?
    private var minSpeechConfidence = 0.60
    private var consecutiveFramesNeeded = 1
    private var interruptionObserver: NSObjectProtocol?
    private var mediaServicesResetObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?
    private var fallbackSpeechBurstEnabled = true
    private let fallbackRmsThreshold: Float = 0.025
    private let fallbackMinIntervalMs = 10_000

    var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return engineState == .healthy
    }

    var canAnalyze: Bool {
        lock.lock()
        defer { lock.unlock() }
        return analyzer != nil
            && engine?.isRunning == true
            && ![.stopped, .failed, .suspended, .stale].contains(engineState)
    }

    var isSuspended: Bool {
        lock.lock()
        defer { lock.unlock() }
        return engineState == .suspended
    }

    var diagnostics: SoundClassificationDiagnostics {
        lock.lock()
        defer { lock.unlock() }
        return SoundClassificationDiagnostics(
            engineState: engineState,
            lastFrameAt: lastFrameAt,
            lastError: lastError,
            restartCount: restartCount,
            capturePipelineRunning: engine?.isRunning == true
        )
    }

    func updateConfig(_ config: AudioCaptureConfig) {
        preRollBuffer.updateMaximumDurationMs(config.preRollMs)
    }

    func setFallbackSpeechBurstEnabled(_ enabled: Bool) {
        lock.lock()
        fallbackSpeechBurstEnabled = enabled
        lock.unlock()
    }

    @discardableResult
    func start() -> Bool {
        lock.lock()
        if analyzer != nil,
           engine?.isRunning == true,
           ![.failed, .suspended, .stale, .stopped].contains(engineState) {
            lock.unlock()
            return true
        }
        let restarting = [.failed, .suspended, .stale].contains(engineState)
        if restarting {
            stopAnalyzerLocked(nextState: .restarting)
            restartCount += 1
        } else if engineState == .stopped {
            engineState = .starting
        }
        lock.unlock()

        guard AVAudioApplication.shared.recordPermission == .granted else {
            emitError("Microphone permission not granted", source: "soundAnalysis")
            return false
        }

        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .measurement,
                options: [.mixWithOthers, .allowBluetoothHFP, .defaultToSpeaker]
            )
            try session.setActive(true, options: [])
        } catch {
            emitError("Audio session activation failed: \(error.localizedDescription)", source: "audioSession")
            return false
        }

        let engine: AVAudioEngine
        lock.lock()
        if let existingEngine = self.engine {
            engine = existingEngine
            lock.unlock()
        } else {
            let newEngine = AVAudioEngine()
            self.engine = newEngine
            engine = newEngine
            lock.unlock()
        }

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            emitError("Input audio format is unavailable", source: "audioSession")
            return false
        }

        guard startAnalyzer(format: format, restarting: restarting) else {
            return false
        }

        if !engine.isRunning {
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 8_192, format: format) { [weak self] buffer, time in
                self?.dispatchAudioBuffer(buffer)
                self?.analyze(buffer: buffer, atAudioFramePosition: time.sampleTime)
            }

            do {
                try engine.start()
            } catch {
                input.removeTap(onBus: 0)
                emitError("Audio engine failed to start: \(error.localizedDescription)", source: "audioSession")
                return false
            }
        }

        installInterruptionObserverIfNeeded()
        installMediaServicesResetObserverIfNeeded()
        installRouteChangeObserverIfNeeded()
        let route = session.currentRoute.inputs.map { $0.portType.rawValue }.joined(separator: ",")
        soundLogger.info("SoundAnalysis engine started category=\(session.category.rawValue, privacy: .public) mode=\(session.mode.rawValue, privacy: .public) route=\(route, privacy: .public)")
        return true
    }

    @discardableResult
    func startCapturePipelineOnly() -> Bool {
        lock.lock()
        let alreadyRunning = engine?.isRunning == true
        if alreadyRunning {
            stopAnalyzerLocked(nextState: .suspended)
            lastError = nil
            lock.unlock()
            installInterruptionObserverIfNeeded()
            installMediaServicesResetObserverIfNeeded()
            installRouteChangeObserverIfNeeded()
            return true
        }
        if engineState == .stopped {
            engineState = .starting
        }
        lock.unlock()

        guard AVAudioApplication.shared.recordPermission == .granted else {
            emitError("Microphone permission not granted", source: "audioSession")
            return false
        }

        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .measurement,
                options: [.mixWithOthers, .allowBluetoothHFP, .defaultToSpeaker]
            )
            try session.setActive(true, options: [])
        } catch {
            emitError("Audio session activation failed: \(error.localizedDescription)", source: "audioSession")
            return false
        }

        let engine: AVAudioEngine
        lock.lock()
        if let existingEngine = self.engine {
            engine = existingEngine
        } else {
            let newEngine = AVAudioEngine()
            self.engine = newEngine
            engine = newEngine
        }
        stopAnalyzerLocked(nextState: .suspended)
        lastError = nil
        lock.unlock()

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            emitError("Input audio format is unavailable", source: "audioSession")
            return false
        }

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 8_192, format: format) { [weak self] buffer, time in
            self?.dispatchAudioBuffer(buffer)
            self?.analyze(buffer: buffer, atAudioFramePosition: time.sampleTime)
        }

        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            emitError("Audio engine failed to start: \(error.localizedDescription)", source: "audioSession")
            return false
        }

        installInterruptionObserverIfNeeded()
        installMediaServicesResetObserverIfNeeded()
        installRouteChangeObserverIfNeeded()
        let route = session.currentRoute.inputs.map { $0.portType.rawValue }.joined(separator: ",")
        soundLogger.info("Audio capture pipeline started without SoundAnalysis category=\(session.category.rawValue, privacy: .public) mode=\(session.mode.rawValue, privacy: .public) route=\(route, privacy: .public)")
        return true
    }

    func stop() {
        stopEngine()
        if let observer = interruptionObserver {
            NotificationCenter.default.removeObserver(observer)
            interruptionObserver = nil
        }
        if let observer = mediaServicesResetObserver {
            NotificationCenter.default.removeObserver(observer)
            mediaServicesResetObserver = nil
        }
        if let observer = routeChangeObserver {
            NotificationCenter.default.removeObserver(observer)
            routeChangeObserver = nil
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    func stopAnalyzerOnly() {
        lock.lock()
        let hadAnalyzer = analyzer != nil
        if hadAnalyzer {
            stopAnalyzerLocked(nextState: .suspended)
        }
        lock.unlock()
        if hadAnalyzer {
            soundLogger.info("SoundAnalysis analyzer suspended; engine and audio tap retained")
        }
    }

    func attachRecordingSink(_ sink: AudioRecordingSink) {
        lock.lock()
        self.sink = sink
        self.sinkActive = true
        self.consecutiveSpeechCount = 0
        let format = engine?.inputNode.outputFormat(forBus: 0)
        lock.unlock()

        if let format {
            let preRoll = preRollBuffer.snapshotAndReset()
            sink.recordingDidStart(
                format: format,
                preRollPCM: preRoll.pcm,
                preRollDurationMs: preRoll.durationMs
            )
        }
    }

    func detachRecordingSink() {
        lock.lock()
        self.sink = nil
        self.sinkActive = false
        self.consecutiveSpeechCount = 0
        lock.unlock()
    }

    private func installInterruptionObserverIfNeeded() {
        guard interruptionObserver == nil else { return }
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            self?.handleInterruption(notification)
        }
    }

    private func installMediaServicesResetObserverIfNeeded() {
        guard mediaServicesResetObserver == nil else { return }
        mediaServicesResetObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] _ in
            self?.handleMediaServicesReset()
        }
    }

    private func installRouteChangeObserverIfNeeded() {
        guard routeChangeObserver == nil else { return }
        routeChangeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            self?.handleRouteChange(notification)
        }
    }

    private func handleMediaServicesReset() {
        soundLogger.error("AVAudioSession mediaServicesWereReset, restarting engine")
        lock.lock()
        lastError = "mediaServicesWereReset"
        stopAnalyzerLocked(nextState: .failed)
        lock.unlock()
        stopEngine()
        onAnalyzerFailed?("AVAudioSession media services were reset")
    }

    private func handleRouteChange(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let value = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: value) else {
            return
        }
        switch reason {
        case .oldDeviceUnavailable, .newDeviceAvailable, .override, .categoryChange, .routeConfigurationChange:
            let route = AVAudioSession.sharedInstance().currentRoute.inputs.map { $0.portType.rawValue }.joined(separator: ",")
            soundLogger.info("AVAudioSession route changed reason=\(reason.rawValue, privacy: .public) route=\(route, privacy: .public)")
            lock.lock()
            let needsRestart = engine?.inputNode.outputFormat(forBus: 0).sampleRate == 0
            lock.unlock()
            if needsRestart {
                stopEngine()
                onAnalyzerFailed?("Audio route changed, engine input unavailable")
            }
        default:
            break
        }
    }

    private func stopEngine() {
        lock.lock()
        guard engine != nil || analyzer != nil else {
            lock.unlock()
            return
        }
        let engine = self.engine
        self.engine = nil
        stopAnalyzerLocked(nextState: .stopped)
        self.sink = nil
        self.sinkActive = false
        self.consecutiveSpeechCount = 0
        lock.unlock()

        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        soundLogger.info("SoundAnalysis engine stopped")
    }

    private func startAnalyzer(format: AVAudioFormat, restarting: Bool) -> Bool {
        let analyzer = SNAudioStreamAnalyzer(format: format)
        let request: SNClassifySoundRequest
        do {
            request = try SNClassifySoundRequest(classifierIdentifier: .version1)
        } catch {
            emitError("Sound classifier unavailable: \(error.localizedDescription)", source: "soundAnalysis")
            return false
        }
        request.windowDuration = CMTime(seconds: 1.5, preferredTimescale: 48_000)
        request.overlapFactor = 0

        let observer = ClassificationObserver { [weak self] frame in
            self?.handleClassification(frame)
        } onFailure: { [weak self] message in
            self?.handleAnalyzerFailure(message)
        }

        do {
            try analyzer.add(request, withObserver: observer)
        } catch {
            emitError("Unable to attach sound classifier: \(error.localizedDescription)", source: "soundAnalysis")
            return false
        }

        lock.lock()
        self.analyzer = analyzer
        self.observer = observer
        self.lastFrameAt = nil
        self.lastError = nil
        self.engineState = restarting ? .restarting : .starting
        lock.unlock()
        return true
    }

    private func stopAnalyzerLocked(nextState: AudioEngineState) {
        analyzer = nil
        observer = nil
        engineState = nextState
        consecutiveSpeechCount = 0
    }

    private func analyze(buffer: AVAudioPCMBuffer, atAudioFramePosition framePosition: AVAudioFramePosition) {
        lock.lock()
        let currentAnalyzer = analyzer
        let canAnalyze = currentAnalyzer != nil
            && ![.stopped, .failed, .suspended, .stale].contains(engineState)
        lock.unlock()

        guard canAnalyze, let currentAnalyzer else { return }
        analysisQueue.async {
            currentAnalyzer.analyze(buffer, atAudioFramePosition: framePosition)
        }
    }

    private func dispatchAudioBuffer(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let active = sinkActive
        let currentSink = sink
        lock.unlock()

        if active, let currentSink {
            currentSink.recordingDidReceive(buffer: buffer)
            if isFallbackSpeech(buffer) {
                onSpeechFrame?()
            }
        } else {
            preRollBuffer.append(buffer: buffer)
            maybeEmitFallbackSpeechBurst(buffer)
        }
    }

    private func maybeEmitFallbackSpeechBurst(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let now = Date()
        let analyzerUnavailable = [.failed, .suspended, .stale].contains(engineState)
        let elapsedMs = lastFallbackBurstAt.map { Int(now.timeIntervalSince($0) * 1_000) } ?? Int.max
        let canFire = fallbackSpeechBurstEnabled && analyzerUnavailable && elapsedMs >= fallbackMinIntervalMs
        lock.unlock()

        guard canFire, isFallbackSpeech(buffer) else {
            return
        }

        lock.lock()
        lastFallbackBurstAt = now
        lock.unlock()

        onSpeechBurst?(min(1, Double((Self.rms(buffer: buffer) ?? fallbackRmsThreshold) / 0.08)), "audio_vad_fallback")
    }

    private func isFallbackSpeech(_ buffer: AVAudioPCMBuffer) -> Bool {
        guard let rms = Self.rms(buffer: buffer) else { return false }
        return rms >= fallbackRmsThreshold
    }

    private func handleClassification(_ frame: SoundClassificationFrame) {
        lock.lock()
        lastFrameAt = frame.timestamp
        engineState = .healthy
        lock.unlock()

        if AVAudioSession.sharedInstance().isOtherAudioPlaying {
            onOtherAudioDetected?()
        }

        onFrame?(frame)

        let isSpeech = frame.topLabel.lowercased() == "speech"
            && frame.topConfidence >= minSpeechConfidence
        if isSpeech {
            onSpeechFrame?()
        }

        lock.lock()
        let recording = sinkActive
        if recording {
            lock.unlock()
            return
        }

        if isSpeech {
            consecutiveSpeechCount += 1
        } else {
            consecutiveSpeechCount = 0
        }

        let shouldFire = consecutiveSpeechCount >= consecutiveFramesNeeded
        if shouldFire {
            consecutiveSpeechCount = 0
        }
        lock.unlock()

        if shouldFire {
            onSpeechBurst?(frame.topConfidence, "sound_analysis")
        }
    }

    func markStaleIfNeeded(maxAgeMs: Int) {
        lock.lock()
        let shouldMarkStale: Bool
        if let lastFrameAt,
           analyzer != nil,
           engine?.isRunning == true,
           engineState == .healthy || engineState == .starting || engineState == .restarting {
            shouldMarkStale = Date().timeIntervalSince(lastFrameAt) * 1_000 > Double(maxAgeMs)
        } else {
            shouldMarkStale = false
        }
        if shouldMarkStale {
            stopAnalyzerLocked(nextState: .stale)
        }
        lock.unlock()

        if shouldMarkStale {
            soundLogger.error("SoundAnalysis analyzer marked stale")
            onAnalyzerFailed?("Sound classifier classifications stale")
        }
    }

    private func handleInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let value = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: value) else {
            return
        }

        switch type {
        case .began:
            stopEngine()
            onInterruptionBegan?()
        case .ended:
            onInterruptionEnded?()
        @unknown default:
            break
        }
    }

    private func emitError(_ message: String, source: String) {
        lock.lock()
        lastError = message
        if source == "soundAnalysis" || source == "audioSession" {
            engineState = .failed
        }
        lock.unlock()

        soundLogger.error("\(source, privacy: .public): \(message, privacy: .public)")
        onError?(message, source)
    }

    private func handleAnalyzerFailure(_ message: String) {
        let state: AudioEngineState = Self.isBackgroundExecutionFailure(message) ? .suspended : .failed
        lock.lock()
        lastError = message
        stopAnalyzerLocked(nextState: state)
        lock.unlock()

        soundLogger.error("SoundAnalysis analyzer failed: \(message, privacy: .public)")
        onError?(message, "soundAnalysis")
        onAnalyzerFailed?(message)
    }

    private static func isBackgroundExecutionFailure(_ message: String) -> Bool {
        let lowercased = message.lowercased()
        return lowercased.contains("background")
            || lowercased.contains("backgroundexecutionnotpermitted")
            || lowercased.contains("insufficient permission")
            || lowercased.contains("gpu")
            || lowercased.contains("coreml")
            || lowercased.contains("com.apple.coreml")
            || lowercased.contains("espresso")
            || lowercased.contains("kiogpu")
    }

    private static func rms(buffer: AVAudioPCMBuffer) -> Float? {
        let frameLength = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        guard frameLength > 0, channelCount > 0 else { return nil }

        if let channels = buffer.floatChannelData {
            var sumSquares: Float = 0
            for channel in 0..<channelCount {
                let samples = channels[channel]
                for index in 0..<frameLength {
                    let sample = samples[index]
                    sumSquares += sample * sample
                }
            }
            return sqrt(sumSquares / Float(frameLength * channelCount))
        }

        if let channels = buffer.int16ChannelData {
            var sumSquares: Float = 0
            for channel in 0..<channelCount {
                let samples = channels[channel]
                for index in 0..<frameLength {
                    let sample = Float(samples[index]) / Float(Int16.max)
                    sumSquares += sample * sample
                }
            }
            return sqrt(sumSquares / Float(frameLength * channelCount))
        }

        return nil
    }
}

private final class ClassificationObserver: NSObject, SNResultsObserving {
    private let onFrame: (SoundClassificationFrame) -> Void
    private let onFailure: (String) -> Void

    init(
        onFrame: @escaping (SoundClassificationFrame) -> Void,
        onFailure: @escaping (String) -> Void
    ) {
        self.onFrame = onFrame
        self.onFailure = onFailure
        super.init()
    }

    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult,
              let top = result.classifications.first else {
            return
        }
        let entries = result.classifications.prefix(3).map {
            SoundClassificationFrame.Entry(label: $0.identifier, confidence: $0.confidence)
        }
        onFrame(SoundClassificationFrame(
            topLabel: top.identifier,
            topConfidence: top.confidence,
            top: entries,
            timestamp: Date()
        ))
    }

    func request(_ request: SNRequest, didFailWithError error: Error) {
        let nsError = error as NSError
        let chain = Self.flatten(nsError)
        onFailure("Sound classifier failed: \(error.localizedDescription) [\(chain)]")
    }

    private static func flatten(_ error: NSError) -> String {
        var parts: [String] = ["\(error.domain)#\(error.code)"]
        var current = error.userInfo[NSUnderlyingErrorKey] as? NSError
        var depth = 0
        while let next = current, depth < 4 {
            parts.append("\(next.domain)#\(next.code)")
            current = next.userInfo[NSUnderlyingErrorKey] as? NSError
            depth += 1
        }
        return parts.joined(separator: " <- ")
    }
}

final class AudioPreRollBuffer {
    private let lock = NSLock()
    private var pcm = Data()
    private var durationMs = 0
    private var sampleRate: Double = 16_000
    private var channels: UInt16 = 1
    private var maximumDurationMs = AudioCaptureConfig.defaultPreRollMs

    func updateMaximumDurationMs(_ value: Int) {
        lock.lock()
        maximumDurationMs = max(0, value)
        trimIfNeeded()
        lock.unlock()
    }

    func append(buffer: AVAudioPCMBuffer) {
        guard let converted = PCMBufferConverter.convert(buffer) else { return }
        lock.lock()
        sampleRate = converted.sampleRate
        channels = converted.channels
        pcm.append(converted.pcm)
        durationMs += converted.durationMs
        trimIfNeeded()
        lock.unlock()
    }

    func snapshotAndReset() -> (pcm: Data, durationMs: Int) {
        lock.lock()
        let result = (pcm, durationMs)
        pcm = Data()
        durationMs = 0
        lock.unlock()
        return result
    }

    private func trimIfNeeded() {
        guard maximumDurationMs > 0 else {
            pcm.removeAll(keepingCapacity: false)
            durationMs = 0
            return
        }
        guard durationMs > maximumDurationMs else { return }
        let bytesPerMs = max(1, Int((sampleRate * Double(channels) * 2.0) / 1_000.0))
        let excessMs = durationMs - maximumDurationMs
        var bytesToDrop = min(pcm.count, excessMs * bytesPerMs)
        bytesToDrop -= bytesToDrop % max(2, Int(channels) * 2)
        if bytesToDrop > 0 {
            pcm.removeFirst(bytesToDrop)
        }
        durationMs = min(durationMs, maximumDurationMs)
    }
}

enum PCMBufferConverter {
    static func convert(_ buffer: AVAudioPCMBuffer) -> (pcm: Data, durationMs: Int, sampleRate: Double, channels: UInt16)? {
        guard let channelData = buffer.floatChannelData else { return nil }
        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0 else { return nil }

        let sampleRate = buffer.format.sampleRate
        let channels: UInt16 = 1
        let source = channelData[0]
        var data = Data(capacity: frameCount * 2)

        for i in 0..<frameCount {
            let sample = max(-1.0, min(1.0, source[i]))
            let intValue = Int16(clamping: Int(sample * 32_767.0))
            var little = intValue.littleEndian
            data.append(Data(bytes: &little, count: 2))
        }

        let durationMs = sampleRate > 0
            ? Int((Double(frameCount) / sampleRate) * 1_000.0)
            : 0
        return (data, durationMs, sampleRate, channels)
    }
}
