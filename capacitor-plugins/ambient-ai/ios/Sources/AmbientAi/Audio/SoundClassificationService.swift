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
    var onSpeechBurst: ((Double) -> Void)?
    var onOtherAudioDetected: (() -> Void)?
    var onInterruptionBegan: (() -> Void)?
    var onInterruptionEnded: (() -> Void)?
    var onError: ((String, String) -> Void)?

    private let lock = NSLock()
    private let analysisQueue = DispatchQueue(label: "ai.pin.ambient-ai.sound-analysis", qos: .utility)
    private let preRollBuffer = AudioPreRollBuffer()

    private var engine: AVAudioEngine?
    private var analyzer: SNAudioStreamAnalyzer?
    private var observer: ClassificationObserver?
    private weak var sink: AudioRecordingSink?
    private var sinkActive = false
    private var isStarted = false
    private var consecutiveSpeechCount = 0
    private var minSpeechConfidence = 0.60
    private var consecutiveFramesNeeded = 1
    private var interruptionObserver: NSObjectProtocol?

    var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return isStarted
    }

    func updateConfig(_ config: AudioCaptureConfig) {
        preRollBuffer.updateMaximumDurationMs(config.preRollMs)
    }

    @discardableResult
    func start() -> Bool {
        lock.lock()
        if isStarted {
            lock.unlock()
            return true
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
                options: [.mixWithOthers, .allowBluetooth, .defaultToSpeaker]
            )
            try session.setActive(true, options: [])
        } catch {
            emitError("Audio session activation failed: \(error.localizedDescription)", source: "audioSession")
            return false
        }

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            emitError("Input audio format is unavailable", source: "audioSession")
            return false
        }

        let analyzer = SNAudioStreamAnalyzer(format: format)
        let request: SNClassifySoundRequest
        do {
            request = try SNClassifySoundRequest(classifierIdentifier: .version1)
        } catch {
            emitError("Sound classifier unavailable: \(error.localizedDescription)", source: "soundAnalysis")
            return false
        }
        request.windowDuration = CMTime(seconds: 0.75, preferredTimescale: 48_000)
        request.overlapFactor = 0.25

        let observer = ClassificationObserver { [weak self] frame in
            self?.handleClassification(frame)
        } onFailure: { [weak self] message in
            self?.emitError(message, source: "soundAnalysis")
        }

        do {
            try analyzer.add(request, withObserver: observer)
        } catch {
            emitError("Unable to attach sound classifier: \(error.localizedDescription)", source: "soundAnalysis")
            return false
        }

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 8_192, format: format) { [weak self, weak analyzer] buffer, time in
            guard let self else { return }
            self.dispatchAudioBuffer(buffer)
            let framePosition = time.sampleTime
            self.analysisQueue.async {
                analyzer?.analyze(buffer, atAudioFramePosition: framePosition)
            }
        }

        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            emitError("Audio engine failed to start: \(error.localizedDescription)", source: "audioSession")
            return false
        }

        lock.lock()
        self.engine = engine
        self.analyzer = analyzer
        self.observer = observer
        self.isStarted = true
        lock.unlock()

        installInterruptionObserverIfNeeded()
        soundLogger.info("SoundAnalysis engine started")
        return true
    }

    func stop() {
        stopEngine()
        if let observer = interruptionObserver {
            NotificationCenter.default.removeObserver(observer)
            interruptionObserver = nil
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
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

    private func stopEngine() {
        lock.lock()
        guard isStarted else {
            lock.unlock()
            return
        }
        let engine = self.engine
        self.engine = nil
        self.analyzer = nil
        self.observer = nil
        self.isStarted = false
        self.sink = nil
        self.sinkActive = false
        self.consecutiveSpeechCount = 0
        lock.unlock()

        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        soundLogger.info("SoundAnalysis engine stopped")
    }

    private func dispatchAudioBuffer(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let active = sinkActive
        let currentSink = sink
        lock.unlock()

        if active, let currentSink {
            currentSink.recordingDidReceive(buffer: buffer)
        } else {
            preRollBuffer.append(buffer: buffer)
        }
    }

    private func handleClassification(_ frame: SoundClassificationFrame) {
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
            onSpeechBurst?(frame.topConfidence)
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
        soundLogger.error("\(source, privacy: .public): \(message, privacy: .public)")
        onError?(message, source)
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
        onFailure("Sound classifier failed: \(error.localizedDescription)")
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
