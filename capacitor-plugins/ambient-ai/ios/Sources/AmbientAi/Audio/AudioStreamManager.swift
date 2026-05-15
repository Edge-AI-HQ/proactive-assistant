import AVFoundation
import Foundation
import Speech

actor AudioStreamManager {
    struct Callbacks {
        let emitEvent: (String, [String: Any]) -> Void
    }

    private static let maxPendingTranscripts = 300
    private static let maxTranscriptChars = 6_000
    private static let classificationDebugEmitIntervalMs = 2_000

    private let callbacks: Callbacks
    private let classifier = SoundClassificationService()
    private let fileStore = AudioFileStore()
    private let cloudWorker = CloudTranscriptionWorker()

    private var config = AudioCaptureConfig.default
    private var captureSessionId = UUID().uuidString
    private var isCaptureRunning = false
    private var isClassificationRunning = false
    private var isPaused = false
    private var isCapturing = false
    private var stopCurrentRecording = false
    private var suppressionReasons: Set<AudioSuppressedReason> = []
    private var lastSpeechAt = Date()
    private var pendingTranscripts: [TranscriptReadyRecord] = []
    private var segmentIndex = 0
    private var stitcher = TranscriptStitcher()
    private var mediaPollTask: Task<Void, Never>?
    private var secondaryAudioObserver: NSObjectProtocol?
    private var callbacksInstalled = false
    private var lastClassificationDebugEmitAt: Date?

    init(callbacks: Callbacks) {
        self.callbacks = callbacks
        classifier.updateConfig(config)
    }

    // MARK: - Configuration

    func configure(_ config: AudioCaptureConfig) async {
        self.config = config
        classifier.updateConfig(config)
        await fileStore.updateConfig(config)
    }

    // MARK: - Lifecycle

    func startCapture() async throws {
        installClassifierCallbacksIfNeeded()
        await fileStore.ensureDirectory()
        guard !isCaptureRunning else {
            suppressionReasons.remove(.interruption)
            refreshMediaSuppression()
            setupMediaObservers()
            let ok = reconcileClassifierState()
            emitState()
            if !ok && suppressionReasons.isEmpty {
                throw AudioCaptureFailure.engineStartFailed
            }
            return
        }

        captureSessionId = UUID().uuidString
        isCaptureRunning = true
        isPaused = false
        // If iOS delivered an interruption began event but the matching ended
        // event was missed while the WebView/runtime was paused, an explicit
        // user restart should not leave capture permanently suppressed.
        suppressionReasons.remove(.interruption)
        refreshMediaSuppression()
        setupMediaObservers()

        let ok = reconcileClassifierState()
        emitState()
        if !ok && suppressionReasons.isEmpty {
            isCaptureRunning = false
            emitState()
            throw AudioCaptureFailure.engineStartFailed
        }
    }

    func stopCapture() {
        guard isCaptureRunning else {
            emitState()
            return
        }
        isCaptureRunning = false
        stopCurrentRecording = true
        if !isClassificationRunning {
            suppressionReasons.removeAll()
            teardownMediaObservers()
        }
        _ = reconcileClassifierState()
        emitState()
    }

    func startClassification() throws {
        installClassifierCallbacksIfNeeded()
        guard !isClassificationRunning else {
            suppressionReasons.remove(.interruption)
            refreshMediaSuppression()
            setupMediaObservers()
            let ok = reconcileClassifierState()
            emitState()
            if !ok && suppressionReasons.isEmpty {
                throw AudioCaptureFailure.engineStartFailed
            }
            return
        }
        isClassificationRunning = true
        // Same stale-interruption guard as startCapture(): the Debug panel and
        // source toggle are explicit starts, so they should recover the audio
        // engine from a wedged interruption state.
        suppressionReasons.remove(.interruption)
        refreshMediaSuppression()
        setupMediaObservers()
        let ok = reconcileClassifierState()
        emitState()
        if !ok && suppressionReasons.isEmpty {
            isClassificationRunning = false
            emitState()
            throw AudioCaptureFailure.engineStartFailed
        }
    }

    func stopClassification() {
        isClassificationRunning = false
        if !isCaptureRunning {
            suppressionReasons.removeAll()
            teardownMediaObservers()
        }
        _ = reconcileClassifierState()
        emitState()
    }

    func snapshot() -> AudioCaptureSnapshot {
        AudioCaptureSnapshot(
            running: isCaptureRunning,
            paused: isPaused,
            capturing: isCapturing,
            classificationRunning: isClassificationRunning,
            engineRunning: classifier.isRunning,
            suppressedReason: resolvedSuppressedReason()
        )
    }

    func drainPendingTranscripts() -> [[String: Any]] {
        let drained = pendingTranscripts.map(\.payload)
        pendingTranscripts.removeAll()
        return drained
    }

    func listRecentCaptures() async -> [[String: Any]] {
        await fileStore.listRecentCaptures().map(\.recentPayload)
    }

    func captureURL(wavId: String) async -> URL? {
        await fileStore.resolveURL(wavId: wavId)
    }

    func setPlaybackSuppressed(_ suppressed: Bool) {
        if suppressed {
            suppressionReasons.insert(.playback)
        } else {
            suppressionReasons.remove(.playback)
        }
        _ = reconcileClassifierState()
        emitState()
    }

    // MARK: - Classifier callbacks

    private func installClassifierCallbacksIfNeeded() {
        guard !callbacksInstalled else { return }
        callbacksInstalled = true

        classifier.onFrame = { [weak self] frame in
            Task { await self?.handleClassificationFrame(frame) }
        }
        classifier.onSpeechFrame = { [weak self] in
            Task { await self?.markSpeechFrame() }
        }
        classifier.onSpeechBurst = { [weak self] confidence in
            Task { await self?.handleSpeechBurst(confidence: confidence) }
        }
        classifier.onOtherAudioDetected = { [weak self] in
            Task { await self?.handleOtherAudioDetected() }
        }
        classifier.onInterruptionBegan = { [weak self] in
            Task { await self?.handleInterruptionBegan() }
        }
        classifier.onInterruptionEnded = { [weak self] in
            Task { await self?.handleInterruptionEnded() }
        }
        classifier.onError = { [weak self] message, source in
            Task { await self?.emitError(message, source: source) }
        }
    }

    private func handleClassificationFrame(_ frame: SoundClassificationFrame) {
        let now = frame.timestamp
        if let lastClassificationDebugEmitAt {
            let elapsedMs = Int(now.timeIntervalSince(lastClassificationDebugEmitAt) * 1_000)
            guard elapsedMs >= Self.classificationDebugEmitIntervalMs else { return }
        }
        lastClassificationDebugEmitAt = now

        let payload: [String: Any] = [
            "classifications": frame.top.map {
                ["label": $0.label, "confidence": $0.confidence]
            },
            "timestamp": Int(frame.timestamp.timeIntervalSince1970 * 1_000),
        ]
        callbacks.emitEvent("soundClassification", payload)
    }

    private func markSpeechFrame() {
        lastSpeechAt = Date()
    }

    private func handleSpeechBurst(confidence: Double) {
        callbacks.emitEvent("speechBurst", [
            "confidence": confidence,
            "durationMs": 0,
            "timestamp": Int(Date().timeIntervalSince1970 * 1_000),
        ])

        guard isCaptureRunning, !isCapturing, suppressionReasons.isEmpty else {
            return
        }

        isCapturing = true
        stopCurrentRecording = false
        lastSpeechAt = Date()
        emitState()

        let burstId = UUID().uuidString
        let sessionId = captureSessionId
        Task { await self.runOneCaptureCycle(burstId: burstId, captureSessionId: sessionId) }
    }

    private func handleOtherAudioDetected() {
        guard isCaptureRunning || isClassificationRunning else { return }
        guard !suppressionReasons.contains(.media) else { return }
        suppressionReasons.insert(.media)
        startMediaResumePolling()
        _ = reconcileClassifierState()
        emitState()
    }

    private func handleInterruptionBegan() {
        suppressionReasons.insert(.interruption)
        emitState()
    }

    private func handleInterruptionEnded() {
        suppressionReasons.remove(.interruption)
        _ = reconcileClassifierState()
        emitState()
    }

    // MARK: - Capture cycle

    private func runOneCaptureCycle(burstId: String, captureSessionId: String) async {
        defer {
            classifier.detachRecordingSink()
            isCapturing = false
            stopCurrentRecording = false
            _ = reconcileClassifierState()
            emitState()
        }

        let activeConfig = config
        let recorder = RecordingState()
        classifier.attachRecordingSink(recorder)

        let startedAt = Date()
        let deadline = startedAt.addingTimeInterval(TimeInterval(activeConfig.maxBurstMs) / 1_000.0)
        while Date() < deadline,
              isCaptureRunning,
              !stopCurrentRecording,
              !Task.isCancelled {
            let elapsedMs = Int(Date().timeIntervalSince(startedAt) * 1_000)
            if elapsedMs >= activeConfig.minBurstMs {
                let silenceMs = Int(Date().timeIntervalSince(lastSpeechAt) * 1_000)
                if silenceMs >= activeConfig.postRollMs {
                    break
                }
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }

        classifier.detachRecordingSink()
        let snapshot = recorder.snapshot()
        guard !snapshot.pcm.isEmpty, snapshot.durationMs > 0 else {
            emitError("Recording burst produced no audio", source: "capture")
            return
        }

        let capturedAt = Date()
        let metadata: AudioCaptureMetadata
        do {
            metadata = try await fileStore.saveWav(
                pcmData: snapshot.pcm,
                burstId: burstId,
                captureSessionId: captureSessionId,
                capturedAt: capturedAt,
                durationMs: snapshot.durationMs,
                sampleRate: UInt32(snapshot.sampleRate),
                channels: snapshot.channels
            )
        } catch {
            emitError("Failed to save WAV capture", source: "capture")
            return
        }

        let localResult = await transcribeLocally(wavURL: metadata.url, durationMs: snapshot.durationMs)
        let localText = localResult?.text ?? ""
        let transcriptLocale = localResult?.localeId
        let stitchedText = localText.isEmpty ? "" : stitcher.append(localText, at: capturedAt)
        emitTranscriptDraft(
            text: stitchedText,
            metadata: metadata,
            transcriptLocale: transcriptLocale
        )

        let refinedText = activeConfig.canRefineDirectly
            ? await cloudWorker.refine(wavURL: metadata.url, config: activeConfig)
            : nil

        if let refinedText, !refinedText.isEmpty {
            emitTranscriptRefined(text: refinedText, metadata: metadata, transcriptLocale: transcriptLocale)
            emitTranscriptReady(
                text: refinedText,
                metadata: metadata,
                provider: .cloudWhisper,
                fallback: false,
                transcriptLocale: transcriptLocale
            )
        } else {
            emitTranscriptReady(
                text: stitchedText,
                metadata: metadata,
                provider: .localSpeech,
                fallback: activeConfig.canRefineDirectly,
                transcriptLocale: transcriptLocale
            )
        }
    }

    private func transcribeLocally(wavURL: URL, durationMs: Int) async -> LocalTranscriptionResult? {
        guard await Self.ensureSpeechAuthorization() else {
            emitError("Speech recognition permission not granted", source: "transcription")
            return nil
        }

        let candidates = Self.recognitionLocaleCandidates(preferred: config.recognitionLocale)
        var results: [LocalTranscriptionResult] = []
        var attemptedRecognition = false

        for localeId in candidates {
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)),
                  recognizer.isAvailable else {
                continue
            }
            attemptedRecognition = true
            if let result = await runRecognition(
                recognizer: recognizer,
                wavURL: wavURL,
                durationMs: durationMs,
                localeId: localeId
            ), !result.text.isEmpty {
                results.append(result)
            }
        }

        guard let best = Self.bestRecognitionResult(results) else {
            if !attemptedRecognition {
                emitError("Speech recognizer unavailable", source: "transcription")
            }
            return nil
        }
        return best
    }

    private func runRecognition(
        recognizer: SFSpeechRecognizer,
        wavURL: URL,
        durationMs: Int,
        localeId: String
    ) async -> LocalTranscriptionResult? {
        let requiresOnDevice = recognizer.supportsOnDeviceRecognition

        let request = SFSpeechURLRecognitionRequest(url: wavURL)
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.requiresOnDeviceRecognition = requiresOnDevice
        if #available(iOS 16.0, *) {
            request.addsPunctuation = true
        }

        let timeoutSeconds = max(8, min(30, Int(Double(durationMs) / 1_000.0 * 1.5) + 8))
        return await withCheckedContinuation { continuation in
            let resumed = ResumeFlag()
            let accumulator = SpeechRecognitionAccumulator()
            var recognitionTask: SFSpeechRecognitionTask?

            recognitionTask = recognizer.recognitionTask(with: request) { result, error in
                if let result {
                    let confidence = Self.averageConfidence(result.bestTranscription.segments)
                    accumulator.update(
                        text: result.bestTranscription.formattedString,
                        confidence: confidence
                    )
                    if result.isFinal, resumed.takeOnce() {
                        recognitionTask?.cancel()
                        let snapshot = accumulator.snapshot()
                        continuation.resume(returning: LocalTranscriptionResult(
                            text: snapshot.text,
                            localeId: localeId,
                            onDevice: requiresOnDevice,
                            confidence: max(confidence, snapshot.confidence),
                            isFinal: true
                        ))
                    }
                }
                if error != nil, resumed.takeOnce() {
                    recognitionTask?.cancel()
                    let snapshot = accumulator.snapshot()
                    continuation.resume(returning: snapshot.text.isEmpty ? nil : LocalTranscriptionResult(
                        text: snapshot.text,
                        localeId: localeId,
                        onDevice: requiresOnDevice,
                        confidence: snapshot.confidence,
                        isFinal: false
                    ))
                }
            }

            Task {
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
                if resumed.takeOnce() {
                    recognitionTask?.cancel()
                    let snapshot = accumulator.snapshot()
                    continuation.resume(returning: snapshot.text.isEmpty ? nil : LocalTranscriptionResult(
                        text: snapshot.text,
                        localeId: localeId,
                        onDevice: requiresOnDevice,
                        confidence: snapshot.confidence,
                        isFinal: false
                    ))
                }
            }
        }
    }

    private static func recognitionLocaleCandidates(preferred: String?) -> [String] {
        let requested = preferred?.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestedFirst = requested?.lowercased().hasPrefix("en") == true ? "en-US" : "zh-CN"
        let deviceFirst = (Locale.preferredLanguages.first ?? Locale.current.identifier)
            .lowercased()
            .hasPrefix("zh") ? "zh-CN" : "en-US"
        let first = requested?.isEmpty == false ? requestedFirst : deviceFirst
        let second = first == "zh-CN" ? "en-US" : "zh-CN"
        return [first, second]
    }

    private static func bestRecognitionResult(_ results: [LocalTranscriptionResult]) -> LocalTranscriptionResult? {
        results.max { lhs, rhs in
            recognitionScore(lhs) < recognitionScore(rhs)
        }
    }

    private static func recognitionScore(_ result: LocalTranscriptionResult) -> Double {
        let zhCount = result.text.unicodeScalars.filter(isChineseScalar).count
        let latinCount = result.text.unicodeScalars.filter {
            CharacterSet.letters.contains($0) && !isChineseScalar($0)
        }.count
        let lowerLocale = result.localeId.lowercased()

        var score = Double(max(result.confidence, 0)) * 1.5
        score += min(Double(result.text.count), 1200) / 900.0
        if result.onDevice { score += 0.15 }
        if result.isFinal { score += 0.08 }

        if lowerLocale.hasPrefix("zh") {
            score += zhCount > 0 ? 0.75 : -0.35
            if zhCount == 0, latinCount > 8 { score -= 0.25 }
        } else if lowerLocale.hasPrefix("en") {
            score += latinCount > 0 ? 0.35 : -0.25
            if zhCount > 0 { score -= 0.45 }
        }
        return score
    }

    private static func averageConfidence(_ segments: [SFTranscriptionSegment]) -> Float {
        let usable = segments.map(\.confidence).filter { $0 > 0 }
        guard !usable.isEmpty else { return 0 }
        return usable.reduce(0, +) / Float(usable.count)
    }

    private static func isChineseScalar(_ scalar: UnicodeScalar) -> Bool {
        switch scalar.value {
        case 0x4E00...0x9FFF, 0x3400...0x4DBF, 0xF900...0xFAFF:
            return true
        default:
            return false
        }
    }

    private static func ensureSpeechAuthorization() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            return true
        case .denied, .restricted:
            return false
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: status == .authorized)
                }
            }
        @unknown default:
            return false
        }
    }

    // MARK: - Event payloads

    private func emitTranscriptDraft(
        text: String,
        metadata: AudioCaptureMetadata,
        transcriptLocale: String?
    ) {
        var payload: [String: Any] = [
            "platform": "ios",
            "wavId": metadata.wavId,
            "burstId": metadata.burstId,
            "captureSessionId": metadata.captureSessionId,
            "text": text,
            "capturedAt": iso8601(metadata.capturedAt),
            "durationMs": metadata.durationMs,
        ]
        if let transcriptLocale {
            payload["transcriptLocale"] = transcriptLocale
        }
        callbacks.emitEvent("transcriptDraft", payload)
    }

    private func emitTranscriptRefined(
        text: String,
        metadata: AudioCaptureMetadata,
        transcriptLocale: String?
    ) {
        var payload: [String: Any] = [
            "platform": "ios",
            "wavId": metadata.wavId,
            "burstId": metadata.burstId,
            "captureSessionId": metadata.captureSessionId,
            "refinedText": String(text.prefix(Self.maxTranscriptChars)),
            "capturedAt": iso8601(metadata.capturedAt),
            "provider": AudioTranscriptProvider.cloudWhisper.rawValue,
            "localProvider": AudioLocalSpeechProvider.sfSpeech.rawValue,
        ]
        if let transcriptLocale {
            payload["transcriptLocale"] = transcriptLocale
        }
        callbacks.emitEvent("transcriptRefined", payload)
    }

    private func emitTranscriptReady(
        text: String,
        metadata: AudioCaptureMetadata,
        provider: AudioTranscriptProvider,
        fallback: Bool,
        transcriptLocale: String?
    ) {
        segmentIndex += 1
        let record = TranscriptReadyRecord(
            platform: "ios",
            wavId: metadata.wavId,
            burstId: metadata.burstId,
            captureSessionId: metadata.captureSessionId,
            text: String(text.prefix(Self.maxTranscriptChars)),
            capturedAt: metadata.capturedAt,
            durationMs: metadata.durationMs,
            provider: provider,
            fallback: fallback,
            localProvider: .sfSpeech,
            segmentIndex: segmentIndex,
            transcriptLocale: transcriptLocale
        )
        pendingTranscripts.append(record)
        if pendingTranscripts.count > Self.maxPendingTranscripts {
            pendingTranscripts.removeFirst(pendingTranscripts.count - Self.maxPendingTranscripts)
        }
        callbacks.emitEvent("transcriptReady", record.payload)
    }

    private func emitState() {
        callbacks.emitEvent("audioState", snapshot().payload)
    }

    private func emitError(_ message: String, source: String) {
        callbacks.emitEvent("audioError", [
            "message": message,
            "source": source,
        ])
    }

    private func iso8601(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    // MARK: - Suppression

    private func refreshMediaSuppression() {
        if AVAudioSession.sharedInstance().isOtherAudioPlaying {
            suppressionReasons.insert(.media)
            startMediaResumePolling()
        } else {
            suppressionReasons.remove(.media)
            stopMediaResumePolling()
        }
    }

    private func resolvedSuppressedReason() -> AudioSuppressedReason? {
        if suppressionReasons.contains(.playback) { return .playback }
        if suppressionReasons.contains(.interruption) { return .interruption }
        if suppressionReasons.contains(.media) { return .media }
        return nil
    }

    private var shouldClassifierRun: Bool {
        (isCaptureRunning || isClassificationRunning) && suppressionReasons.isEmpty
    }

    @discardableResult
    private func reconcileClassifierState() -> Bool {
        if shouldClassifierRun {
            return classifier.isRunning || classifier.start()
        }
        if classifier.isRunning {
            classifier.stop()
        }
        return true
    }

    private func setupMediaObservers() {
        guard secondaryAudioObserver == nil else { return }
        secondaryAudioObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.silenceSecondaryAudioHintNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            guard let userInfo = notification.userInfo,
                  let value = userInfo[AVAudioSessionSilenceSecondaryAudioHintTypeKey] as? UInt,
                  let type = AVAudioSession.SilenceSecondaryAudioHintType(rawValue: value) else {
                return
            }
            Task { await self?.handleSecondaryAudioHint(type) }
        }
    }

    private func teardownMediaObservers() {
        if let secondaryAudioObserver {
            NotificationCenter.default.removeObserver(secondaryAudioObserver)
            self.secondaryAudioObserver = nil
        }
        stopMediaResumePolling()
    }

    private func handleSecondaryAudioHint(_ type: AVAudioSession.SilenceSecondaryAudioHintType) {
        switch type {
        case .begin:
            handleOtherAudioDetected()
        case .end:
            suppressionReasons.remove(.media)
            stopMediaResumePolling()
            _ = reconcileClassifierState()
            emitState()
        @unknown default:
            break
        }
    }

    private func startMediaResumePolling() {
        stopMediaResumePolling()
        mediaPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if !AVAudioSession.sharedInstance().isOtherAudioPlaying {
                    await self?.clearMediaSuppressionFromPoll()
                    return
                }
            }
        }
    }

    private func stopMediaResumePolling() {
        mediaPollTask?.cancel()
        mediaPollTask = nil
    }

    private func clearMediaSuppressionFromPoll() {
        guard suppressionReasons.contains(.media) else { return }
        suppressionReasons.remove(.media)
        stopMediaResumePolling()
        _ = reconcileClassifierState()
        emitState()
    }
}

private final class RecordingState: AudioRecordingSink {
    private let lock = NSLock()
    private var pcm = Data()
    private var totalMs = 0
    private var sampleRate: Double = 16_000
    private var channels: UInt16 = 1

    func recordingDidStart(
        format: AVAudioFormat,
        preRollPCM: Data,
        preRollDurationMs: Int
    ) {
        lock.lock()
        sampleRate = format.sampleRate
        channels = 1
        if !preRollPCM.isEmpty {
            pcm.append(preRollPCM)
            totalMs += preRollDurationMs
        }
        lock.unlock()
    }

    func recordingDidReceive(buffer: AVAudioPCMBuffer) {
        guard let converted = PCMBufferConverter.convert(buffer) else { return }
        lock.lock()
        sampleRate = converted.sampleRate
        channels = converted.channels
        pcm.append(converted.pcm)
        totalMs += converted.durationMs
        lock.unlock()
    }

    func snapshot() -> (pcm: Data, durationMs: Int, sampleRate: Double, channels: UInt16) {
        lock.lock()
        defer { lock.unlock() }
        return (pcm, totalMs, sampleRate, channels)
    }
}

private final class ResumeFlag {
    private let lock = NSLock()
    private var resumed = false

    func takeOnce() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if resumed { return false }
        resumed = true
        return true
    }
}

private struct LocalTranscriptionResult {
    let text: String
    let localeId: String
    let onDevice: Bool
    let confidence: Float
    let isFinal: Bool
}

private final class SpeechRecognitionAccumulator {
    private let lock = NSLock()
    private var bestText = ""
    private var bestConfidence: Float = 0

    func update(text: String, confidence: Float) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        lock.lock()
        if trimmed.count >= bestText.count {
            bestText = trimmed
            bestConfidence = confidence
        }
        lock.unlock()
    }

    func snapshot() -> (text: String, confidence: Float) {
        lock.lock()
        defer { lock.unlock() }
        return (bestText, bestConfidence)
    }
}
