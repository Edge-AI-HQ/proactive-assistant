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
    private static let classificationStaleTimeoutMs = 15_000

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
    private var appIsBackgrounded = false
    private let speechRecognitionCoordinator = SpeechRecognitionCoordinator()

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
            let ok = reconcileClassifierState(reason: "startCapture")
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

        let ok = reconcileClassifierState(reason: "startCapture")
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
        _ = reconcileClassifierState(reason: "stopCapture")
        emitState()
    }

    func startClassification() throws {
        installClassifierCallbacksIfNeeded()
        guard !isClassificationRunning else {
            suppressionReasons.remove(.interruption)
            refreshMediaSuppression()
            setupMediaObservers()
            let ok = reconcileClassifierState(reason: "startClassification")
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
        let ok = reconcileClassifierState(reason: "startClassification")
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
        _ = reconcileClassifierState(reason: "stopClassification")
        emitState()
    }

    func snapshot() -> AudioCaptureSnapshot {
        classifier.markStaleIfNeeded(maxAgeMs: Self.classificationStaleTimeoutMs)
        let diagnostics = classifier.diagnostics
        return AudioCaptureSnapshot(
            running: isCaptureRunning,
            paused: isPaused,
            capturing: isCapturing,
            classificationRunning: isClassificationRunning,
            engineRunning: classifier.isRunning,
            capturePipelineRunning: diagnostics.capturePipelineRunning,
            engineState: resolvedEngineState(diagnostics.engineState),
            lastClassificationAt: diagnostics.lastFrameAt,
            lastAudioError: diagnostics.lastError,
            classifierRestartCount: diagnostics.restartCount,
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
        _ = reconcileClassifierState(reason: "playbackSuppression")
        emitState()
    }

    func setAppBackgrounded(_ backgrounded: Bool, reason: String) {
        appIsBackgrounded = backgrounded
        if backgrounded {
            classifier.stopAnalyzerOnly()
        } else if isCaptureRunning || isClassificationRunning {
            suppressionReasons.remove(.interruption)
            refreshMediaSuppression()
            setupMediaObservers()
        }
        _ = reconcileClassifierState(reason: reason)
        emitState()
    }

    func recoverClassifierIfNeeded(reason: String) {
        guard isCaptureRunning || isClassificationRunning else {
            emitState()
            return
        }
        suppressionReasons.remove(.interruption)
        refreshMediaSuppression()
        setupMediaObservers()
        _ = reconcileClassifierState(reason: reason)
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
        classifier.onSpeechBurst = { [weak self] confidence, triggerSource in
            Task { await self?.handleSpeechBurst(confidence: confidence, triggerSource: triggerSource) }
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
        classifier.onAnalyzerFailed = { [weak self] _ in
            Task { await self?.handleAnalyzerFailed() }
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

    private func handleSpeechBurst(confidence: Double, triggerSource: String) {
        callbacks.emitEvent("speechBurst", [
            "confidence": confidence,
            "durationMs": 0,
            "timestamp": Int(Date().timeIntervalSince1970 * 1_000),
            "triggerSource": triggerSource,
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
        Task {
            await self.runOneCaptureCycle(
                burstId: burstId,
                captureSessionId: sessionId,
                triggerSource: triggerSource
            )
        }
    }

    private func handleOtherAudioDetected() {
        guard isCaptureRunning || isClassificationRunning else { return }
        guard !suppressionReasons.contains(.media) else { return }
        suppressionReasons.insert(.media)
        startMediaResumePolling()
        _ = reconcileClassifierState(reason: "otherAudioDetected")
        emitState()
    }

    private func handleInterruptionBegan() {
        suppressionReasons.insert(.interruption)
        emitState()
    }

    private func handleInterruptionEnded() {
        suppressionReasons.remove(.interruption)
        _ = reconcileClassifierState(reason: "interruptionEnded")
        emitState()
    }

    private func handleAnalyzerFailed() {
        if isCapturing {
            stopCurrentRecording = true
        }
        emitState()
    }

    // MARK: - Capture cycle

    private func runOneCaptureCycle(
        burstId: String,
        captureSessionId: String,
        triggerSource: String
    ) async {
        defer {
            classifier.detachRecordingSink()
            isCapturing = false
            stopCurrentRecording = false
            _ = reconcileClassifierState(reason: "captureCycleComplete")
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

        emitCaptureReady(
            metadata: metadata,
            triggerSource: triggerSource
        )

        let localResult = await transcribeLocally(wavURL: metadata.url, durationMs: snapshot.durationMs)
        let localText = localResult?.text ?? ""
        let transcriptLocale = localResult?.localeId
        let stitchedDraft = localText.isEmpty ? "" : stitcher.append(localText, at: capturedAt)

        emitTranscriptDraft(
            text: stitchedDraft,
            metadata: metadata,
            triggerSource: triggerSource,
            transcriptLocale: transcriptLocale
        )
        emitTranscriptReady(
            text: stitchedDraft,
            metadata: metadata,
            provider: .localSpeech,
            fallback: activeConfig.canRefineDirectly,
            triggerSource: triggerSource,
            transcriptLocale: transcriptLocale
        )

        if activeConfig.canRefineDirectly {
            let refineURL = metadata.url
            let refineMetadata = metadata
            let refineTrigger = triggerSource
            let refineLocale = transcriptLocale
            let refineConfig = activeConfig
            Task { [weak self] in
                guard let self else { return }
                if let cloudText = await self.cloudWorker.refine(wavURL: refineURL, config: refineConfig),
                   !cloudText.isEmpty {
                    await self.emitCloudRefinement(
                        text: cloudText,
                        metadata: refineMetadata,
                        triggerSource: refineTrigger,
                        transcriptLocale: refineLocale
                    )
                }
            }
        }
    }

    private func emitCloudRefinement(
        text: String,
        metadata: AudioCaptureMetadata,
        triggerSource: String,
        transcriptLocale: String?
    ) {
        emitTranscriptRefined(
            text: text,
            metadata: metadata,
            triggerSource: triggerSource,
            transcriptLocale: transcriptLocale
        )
        emitTranscriptReady(
            text: text,
            metadata: metadata,
            provider: .cloudWhisper,
            fallback: false,
            triggerSource: triggerSource,
            transcriptLocale: transcriptLocale
        )
    }

    private func transcribeLocally(wavURL: URL, durationMs: Int) async -> LocalTranscriptionResult? {
        guard await Self.ensureSpeechAuthorization() else {
            emitError("Speech recognition permission not granted", source: "transcription")
            return nil
        }

        let candidates = Self.preferredLocaleCandidates(userPreferred: config.recognitionLocale)
        let userPinnedLocale = config.recognitionLocale?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        var attemptedRecognition = false

        var onDeviceResults: [LocalTranscriptionResult] = []
        for localeId in candidates {
            guard speechRecognitionCoordinator.canAttemptRecognition(requireOnDevice: true) else { break }
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)),
                  recognizer.isAvailable,
                  recognizer.supportsOnDeviceRecognition else {
                continue
            }
            attemptedRecognition = true
            if let result = await runRecognition(
                recognizer: recognizer,
                wavURL: wavURL,
                requireOnDevice: true,
                localeId: localeId
            ), !result.text.isEmpty {
                if userPinnedLocale, !Self.isRecognitionLikelyTruncated(result, durationMs: durationMs) {
                    return result
                }
                onDeviceResults.append(result)
            }
        }

        if durationMs >= 12_000 {
            for localeId in candidates {
                guard speechRecognitionCoordinator.canAttemptRecognition(requireOnDevice: true) else { break }
                guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)),
                      recognizer.isAvailable,
                      recognizer.supportsOnDeviceRecognition else {
                    continue
                }
                attemptedRecognition = true
                if let result = await runChunkedRecognition(
                    recognizer: recognizer,
                    wavURL: wavURL,
                    requireOnDevice: true,
                    localeId: localeId
                ), !result.text.isEmpty {
                    onDeviceResults.append(result)
                }
            }
        }

        if let best = Self.bestRecognitionResult(onDeviceResults),
           !Self.isRecognitionLikelyTruncated(best, durationMs: durationMs) {
            return best
        }

        var serverResults: [LocalTranscriptionResult] = onDeviceResults
        for localeId in candidates {
            guard speechRecognitionCoordinator.canAttemptRecognition(requireOnDevice: false) else { break }
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)),
                  recognizer.isAvailable else {
                continue
            }
            attemptedRecognition = true
            if let result = await runRecognition(
                recognizer: recognizer,
                wavURL: wavURL,
                requireOnDevice: false,
                localeId: localeId
            ), !result.text.isEmpty {
                if userPinnedLocale, !Self.isRecognitionLikelyTruncated(result, durationMs: durationMs) {
                    return result
                }
                serverResults.append(result)
            }
        }

        if durationMs >= 12_000 {
            for localeId in candidates {
                guard speechRecognitionCoordinator.canAttemptRecognition(requireOnDevice: false) else { break }
                guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)),
                      recognizer.isAvailable else {
                    continue
                }
                attemptedRecognition = true
                if let result = await runChunkedRecognition(
                    recognizer: recognizer,
                    wavURL: wavURL,
                    requireOnDevice: false,
                    localeId: localeId
                ), !result.text.isEmpty {
                    serverResults.append(result)
                }
            }
        }

        let allResults = serverResults
        if let best = Self.bestRecognitionResult(allResults),
           !Self.isRecognitionLikelyTruncated(best, durationMs: durationMs) {
            return best
        }
        if let best = Self.bestRecognitionResult(allResults), durationMs < 12_000 {
            return best
        }
        if !attemptedRecognition {
            emitError("Speech recognizer unavailable", source: "transcription")
        }
        return nil
    }

    private func runRecognition(
        recognizer: SFSpeechRecognizer,
        wavURL: URL,
        requireOnDevice: Bool,
        localeId: String,
        chunked: Bool = false,
        timeoutSecondsOverride: Int? = nil
    ) async -> LocalTranscriptionResult? {
        guard !requireOnDevice || recognizer.supportsOnDeviceRecognition else { return nil }

        let request = SFSpeechURLRecognitionRequest(url: wavURL)
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.requiresOnDeviceRecognition = requireOnDevice
        if #available(iOS 16.0, *) {
            request.addsPunctuation = true
        }

        guard let recognitionRun = speechRecognitionCoordinator.beginRecognition(requireOnDevice: requireOnDevice) else {
            return nil
        }

        let timeoutSeconds = timeoutSecondsOverride ?? Self.recognitionTimeoutSeconds(for: wavURL)
        return await withCheckedContinuation { continuation in
            let resumed = ResumeFlag()
            let accumulator = SpeechRecognitionAccumulator()
            var recognitionTask: SFSpeechRecognitionTask?

            recognitionTask = recognizer.recognitionTask(with: request) { result, error in
                if recognitionRun.isCancelled, resumed.takeOnce() {
                    recognitionTask?.cancel()
                    recognitionRun.finish()
                    continuation.resume(returning: nil)
                    return
                }
                if let result {
                    let confidence = Self.averageConfidence(result.bestTranscription.segments)
                    accumulator.update(
                        text: result.bestTranscription.formattedString,
                        confidence: confidence
                    )
                    if result.isFinal, resumed.takeOnce() {
                        recognitionTask?.cancel()
                        recognitionRun.finish()
                        let snapshot = accumulator.snapshot()
                        continuation.resume(returning: LocalTranscriptionResult(
                            text: String(snapshot.text.prefix(Self.maxTranscriptChars)),
                            localeId: localeId,
                            onDevice: requireOnDevice,
                            confidence: max(confidence, snapshot.confidence),
                            isFinal: true,
                            chunked: chunked
                        ))
                    }
                }
                if let error, resumed.takeOnce() {
                    recognitionTask?.cancel()
                    recognitionRun.noteError(error)
                    let snapshot = accumulator.snapshot()
                    continuation.resume(returning: snapshot.text.isEmpty ? nil : LocalTranscriptionResult(
                        text: String(snapshot.text.prefix(Self.maxTranscriptChars)),
                        localeId: localeId,
                        onDevice: requireOnDevice,
                        confidence: snapshot.confidence,
                        isFinal: false,
                        chunked: chunked
                    ))
                }
            }
            if let recognitionTask {
                recognitionRun.attach(recognitionTask)
            }

            Task {
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
                if resumed.takeOnce() {
                    recognitionTask?.cancel()
                    recognitionRun.finish()
                    let snapshot = accumulator.snapshot()
                    continuation.resume(returning: snapshot.text.isEmpty ? nil : LocalTranscriptionResult(
                        text: String(snapshot.text.prefix(Self.maxTranscriptChars)),
                        localeId: localeId,
                        onDevice: requireOnDevice,
                        confidence: snapshot.confidence,
                        isFinal: false,
                        chunked: chunked
                    ))
                }
            }
        }
    }

    private func runChunkedRecognition(
        recognizer: SFSpeechRecognizer,
        wavURL: URL,
        requireOnDevice: Bool,
        localeId: String
    ) async -> LocalTranscriptionResult? {
        let chunks = Self.makeRecognitionChunks(from: wavURL)
        guard chunks.count > 1 else { return nil }
        defer { for url in chunks { try? FileManager.default.removeItem(at: url) } }

        var merged = ""
        var confidences: [Float] = []
        var sawFinal = false
        for chunk in chunks {
            guard speechRecognitionCoordinator.canAttemptRecognition(requireOnDevice: requireOnDevice) else { break }
            if let result = await runRecognition(
                recognizer: recognizer,
                wavURL: chunk,
                requireOnDevice: requireOnDevice,
                localeId: localeId,
                chunked: true,
                timeoutSecondsOverride: 14
            ), !result.text.isEmpty {
                merged = merged.isEmpty
                    ? result.text
                    : TranscriptStitcher.mergeOverlapping(existing: merged, incoming: result.text)
                if result.confidence > 0 { confidences.append(result.confidence) }
                sawFinal = sawFinal || result.isFinal
            }
        }

        let trimmed = merged.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let confidence = confidences.isEmpty ? 0 : confidences.reduce(0, +) / Float(confidences.count)
        return LocalTranscriptionResult(
            text: String(trimmed.prefix(Self.maxTranscriptChars)),
            localeId: localeId,
            onDevice: requireOnDevice,
            confidence: confidence,
            isFinal: sawFinal,
            chunked: true
        )
    }

    private static func preferredLocaleCandidates(userPreferred: String?) -> [String] {
        let supported = SFSpeechRecognizer.supportedLocales().map { $0.identifier }
        let supportedSet = Set(supported)

        var ordered: [String] = []
        func add(_ id: String) {
            let normalized = id.replacingOccurrences(of: "_", with: "-")
            if let real = supported.first(where: { $0.replacingOccurrences(of: "_", with: "-").hasPrefix(normalized) }) {
                if !ordered.contains(real) { ordered.append(real) }
            } else if supportedSet.contains(id), !ordered.contains(id) {
                ordered.append(id)
            }
        }

        if let preferred = userPreferred?.trimmingCharacters(in: .whitespacesAndNewlines), !preferred.isEmpty {
            add(preferred)
            return ordered
        }

        let deviceLang = Locale.preferredLanguages.first ?? Locale.current.identifier
        let lowerDeviceLang = deviceLang.lowercased()
        if lowerDeviceLang.hasPrefix("zh") || lowerDeviceLang.hasPrefix("yue") {
            add(deviceLang)
            if lowerDeviceLang.contains("hant") || lowerDeviceLang.contains("tw") {
                add("zh-TW")
            } else {
                add("zh-CN")
            }
            add("en-US")
        } else {
            add(deviceLang)
            add("en-US")
            add("zh-CN")
        }
        return ordered
    }

    private static func bestRecognitionResult(_ results: [LocalTranscriptionResult]) -> LocalTranscriptionResult? {
        results.max { lhs, rhs in
            recognitionScore(lhs) < recognitionScore(rhs)
        }
    }

    private static func isRecognitionLikelyTruncated(_ result: LocalTranscriptionResult, durationMs: Int) -> Bool {
        let durationSec = Double(durationMs) / 1_000.0
        guard durationSec >= 8 else { return false }
        let nonWhitespaceCount = result.text.unicodeScalars.filter {
            !CharacterSet.whitespacesAndNewlines.contains($0)
        }.count
        let expectedFloor = max(18, Int(durationSec * 2.2))
        if nonWhitespaceCount < expectedFloor { return true }
        if !result.isFinal && durationSec >= 12 { return true }
        return false
    }

    private static func recognitionTimeoutSeconds(for wavURL: URL) -> Int {
        let duration: Double
        if let file = try? AVAudioFile(forReading: wavURL), file.processingFormat.sampleRate > 0 {
            duration = Double(file.length) / file.processingFormat.sampleRate
        } else {
            duration = 30
        }
        return max(18, min(75, Int(duration * 1.8) + 12))
    }

    private static func makeRecognitionChunks(
        from wavURL: URL,
        chunkSeconds: Double = 8.0,
        overlapSeconds: Double = 0.35
    ) -> [URL] {
        guard let file = try? AVAudioFile(forReading: wavURL) else { return [] }
        let sampleRate = max(1, Int(file.fileFormat.sampleRate))
        let channels = max(1, Int(file.fileFormat.channelCount))
        let bytesPerFrame = channels * 2
        let bytesPerSecond = sampleRate * bytesPerFrame
        guard bytesPerSecond > 0,
              let data = try? Data(contentsOf: wavURL),
              data.count > 44 else { return [] }

        let pcm = Data(data.dropFirst(44))
        let chunkBytes = alignByteCount(Int(chunkSeconds * Double(bytesPerSecond)), frameBytes: bytesPerFrame)
        let overlapBytes = alignByteCount(Int(overlapSeconds * Double(bytesPerSecond)), frameBytes: bytesPerFrame)
        guard chunkBytes > overlapBytes, pcm.count > chunkBytes else { return [] }

        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("pa-speech-chunks-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)

        var urls: [URL] = []
        var offset = 0
        var index = 0
        while offset < pcm.count {
            let end = min(pcm.count, offset + chunkBytes)
            let chunkPCM = Data(pcm[offset..<end])
            if chunkPCM.count < bytesPerSecond { break }
            let wav = AudioFileStore.makeWavHeader(
                dataLength: UInt32(chunkPCM.count),
                sampleRate: UInt32(sampleRate),
                channels: UInt16(channels)
            ) + chunkPCM
            let url = tempDir.appendingPathComponent("chunk-\(index).wav")
            if (try? wav.write(to: url, options: .atomic)) != nil {
                urls.append(url)
            }
            if end >= pcm.count { break }
            offset += chunkBytes - overlapBytes
            index += 1
        }
        return urls
    }

    private static func alignByteCount(_ value: Int, frameBytes: Int) -> Int {
        guard frameBytes > 0 else { return value }
        return value - (value % frameBytes)
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

        if lowerLocale.hasPrefix("zh") || lowerLocale.hasPrefix("yue") {
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
        triggerSource: String,
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
            "triggerSource": triggerSource,
        ]
        if let transcriptLocale {
            payload["transcriptLocale"] = transcriptLocale
        }
        callbacks.emitEvent("transcriptDraft", payload)
    }

    private func emitCaptureReady(
        metadata: AudioCaptureMetadata,
        triggerSource: String
    ) {
        callbacks.emitEvent("captureReady", [
            "platform": "ios",
            "wavId": metadata.wavId,
            "burstId": metadata.burstId,
            "captureSessionId": metadata.captureSessionId,
            "capturedAt": iso8601(metadata.capturedAt),
            "durationMs": metadata.durationMs,
            "byteSize": metadata.byteSize,
            "triggerSource": triggerSource,
        ])
    }

    private func emitTranscriptRefined(
        text: String,
        metadata: AudioCaptureMetadata,
        triggerSource: String,
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
            "triggerSource": triggerSource,
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
        triggerSource: String,
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
            triggerSource: triggerSource,
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

    private func resolvedEngineState(_ state: AudioEngineState) -> AudioEngineState {
        return resolvedSuppressedReason() == nil ? state : .suppressed
    }

    @discardableResult
    private func reconcileClassifierState(reason: String) -> Bool {
        classifier.setFallbackSpeechBurstEnabled(true)
        classifier.markStaleIfNeeded(maxAgeMs: Self.classificationStaleTimeoutMs)
        if shouldClassifierRun {
            if classifier.canAnalyze {
                return true
            }
            if appIsBackgrounded {
                return true
            }
            return classifier.start()
        }
        if classifier.canAnalyze || classifier.diagnostics.capturePipelineRunning {
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
            _ = reconcileClassifierState(reason: "secondaryAudioHintEnded")
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
        _ = reconcileClassifierState(reason: "mediaResumePoll")
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

private final class SpeechRecognitionCoordinator: @unchecked Sendable {
    private let lock = NSLock()
    private var activeTask: SFSpeechRecognitionTask?
    private var cooldownUntil: Date?

    func canAttemptRecognition(requireOnDevice: Bool) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if let cooldownUntil, Date() < cooldownUntil { return false }
        return true
    }

    func beginRecognition(requireOnDevice: Bool) -> SpeechRecognitionRun? {
        lock.lock()
        defer { lock.unlock() }
        if let cooldownUntil, Date() < cooldownUntil { return nil }
        return SpeechRecognitionRun(coordinator: self, requireOnDevice: requireOnDevice)
    }

    fileprivate func attach(_ task: SFSpeechRecognitionTask, run: SpeechRecognitionRun) {
        lock.lock()
        if run.isCancelledLocked {
            lock.unlock()
            task.cancel()
            return
        }
        activeTask = task
        lock.unlock()
    }

    fileprivate func finish(_ run: SpeechRecognitionRun) {
        lock.lock()
        if activeTask === run.task {
            activeTask = nil
        }
        lock.unlock()
    }

    fileprivate func noteError(_ error: Error, run: SpeechRecognitionRun) {
        lock.lock()
        if Self.isLocalSpeechServiceUnavailable(error) {
            cooldownUntil = Date().addingTimeInterval(60)
        }
        if activeTask === run.task {
            activeTask = nil
        }
        lock.unlock()
    }

    private static func isLocalSpeechServiceUnavailable(_ error: Error) -> Bool {
        let nsError = error as NSError
        return nsError.domain == "kAFAssistantErrorDomain" && nsError.code == 1101
    }
}

private final class SpeechRecognitionRun: @unchecked Sendable {
    private let lock = NSLock()
    private weak var coordinator: SpeechRecognitionCoordinator?
    fileprivate var task: SFSpeechRecognitionTask?
    fileprivate let requireOnDevice: Bool
    private var cancelled = false

    fileprivate var isCancelledLocked: Bool {
        cancelled
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    init(coordinator: SpeechRecognitionCoordinator, requireOnDevice: Bool) {
        self.coordinator = coordinator
        self.requireOnDevice = requireOnDevice
    }

    func attach(_ task: SFSpeechRecognitionTask) {
        lock.lock()
        self.task = task
        let shouldCancel = cancelled
        lock.unlock()
        if shouldCancel {
            task.cancel()
        } else {
            coordinator?.attach(task, run: self)
        }
    }

    func finish() {
        lock.lock()
        cancelled = true
        lock.unlock()
        coordinator?.finish(self)
    }

    func noteError(_ error: Error) {
        lock.lock()
        cancelled = true
        lock.unlock()
        coordinator?.noteError(error, run: self)
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
    let chunked: Bool
}

private final class SpeechRecognitionAccumulator {
    private let lock = NSLock()
    private var bestText = ""
    private var bestConfidence: Float = 0

    func update(text: String, confidence: Float) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        lock.lock()
        if trimmed.count > bestText.count || (trimmed.count == bestText.count && confidence > bestConfidence) {
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
