import AVFoundation
import Foundation
import FluidAudio
import os

private let sileroLogger = Logger(subsystem: "ai.pin.ambient-ai", category: "silero-vad")

/// Streaming voice-activity-detection gate backed by Silero VAD v5 via the
/// FluidAudio package. Replaces the prior trigger built on Apple
/// SoundAnalysis's "speech" label, which misfired on keyboard/HVAC/TV
/// background voices because SoundAnalysis is a general acoustic classifier
/// — not a VAD — and the "speech" class was tuned for noisy-but-present
/// human speech rather than absence-of-speech.
///
/// Audio is resampled to 16 kHz mono Float32, accumulated into 4096-sample
/// chunks (the size Silero's CoreML model expects, ~256 ms hop), and run
/// through `VadManager.processStreamingChunk` whose state machine emits
/// `speechStart` / `speechEnd` events with hysteresis. The Apple Neural
/// Engine handles inference (`MLComputeUnits.cpuAndNeuralEngine`).
@available(iOS 17.0, macOS 14.0, *)
final class SileroVadGate {

    struct Configuration {
        /// Silero positive-detection threshold. Conservative ambient-capture
        /// baseline; 0.5 is OpenAI Realtime's "quiet room" default but ambient
        /// background is much noisier so 0.6 holds keyboard/HVAC down.
        var threshold: Float = 0.6
        /// Minimum sustained-speech window before `speechStart` fires. 500ms
        /// rejects single-syllable interjections.
        var minSpeechMs: Int = 500
        /// Silence window before `speechEnd` fires. 700ms keeps short
        /// inter-word pauses inside one burst.
        var minSilenceMs: Int = 700
        /// Padding added before each speechStart sample index so the burst
        /// captures the leading consonant.
        var speechPadMs: Int = 200

        static let ambientDefault = Configuration()
    }

    /// Fired when Silero detects a sustained speech window.
    var onSpeechStart: ((Double) -> Void)?
    /// Fired after a sustained silence window after speech.
    var onSpeechEnd: ((Double) -> Void)?
    /// Fired once after the CoreML model has finished loading. Useful for
    /// suppressing the legacy fallback trigger only after Silero is hot.
    var onModelReady: (() -> Void)?
    /// Fired with a debug-quality message; not all callers act on it.
    var onError: ((String) -> Void)?

    let configuration: Configuration

    private let workQueue = DispatchQueue(
        label: "ai.pin.ambient-ai.silero-vad.work",
        qos: .userInitiated
    )
    private var chunkBuffer = SileroChunkBuffer(chunkSize: VadManager.chunkSize)
    private var processorTask: Task<Void, Never>?
    private var chunkStream: AsyncStream<[Float]>?
    private var chunkContinuation: AsyncStream<[Float]>.Continuation?
    private var converter: AVAudioConverter?
    private var converterSourceFormat: AVAudioFormat?
    private let sileroFormat: AVAudioFormat
    private var isStarted = false

    init(configuration: Configuration = .ambientDefault) {
        self.configuration = configuration
        // Silero expects 16 kHz mono Float32; the converter handles whatever
        // hardware format AVAudioEngine hands us.
        self.sileroFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(VadManager.sampleRate),
            channels: 1,
            interleaved: false
        )!
    }

    /// Begin model loading and chunk processing. Safe to call multiple times
    /// — subsequent calls are no-ops while already started.
    func start() {
        workQueue.async { [weak self] in
            self?.startLocked()
        }
    }

    /// Stop accepting audio and cancel any in-flight model work. After stop
    /// the gate is reusable: call `start()` to resume (the model stays
    /// cached on disk, so re-init is fast).
    func stop() {
        workQueue.async { [weak self] in
            self?.stopLocked()
        }
    }

    /// Feed raw audio captured from the mic. Conversion to Silero's expected
    /// format happens internally on the audio thread (cheap vDSP) and the
    /// downstream model inference happens on `workQueue`.
    func ingest(buffer: AVAudioPCMBuffer) {
        guard let samples = resampleToSileroFormat(buffer) else { return }
        ingest(samplesAt16kMono: samples)
    }

    /// Convenience for callers that already have 16 kHz mono Float32 samples
    /// (and for tests that want to drive the chunk buffer directly).
    func ingest(samplesAt16kMono samples: [Float]) {
        guard !samples.isEmpty else { return }
        workQueue.async { [weak self] in
            self?.appendAndYieldChunks(samples)
        }
    }

    // MARK: - Internals

    private func startLocked() {
        guard !isStarted else { return }
        isStarted = true
        chunkBuffer.reset()
        let (stream, continuation) = SileroVadGate.makeChunkStream()
        chunkStream = stream
        chunkContinuation = continuation
        let config = configuration

        processorTask = Task { [weak self] in
            guard let self else { return }
            let manager: VadManager
            do {
                manager = try await VadManager(
                    config: VadConfig(
                        defaultThreshold: config.threshold,
                        computeUnits: .cpuAndNeuralEngine
                    )
                )
            } catch {
                sileroLogger.error(
                    "Silero VadManager init failed: \(error.localizedDescription, privacy: .public)"
                )
                self.onError?("Silero VadManager init failed: \(error.localizedDescription)")
                return
            }
            self.onModelReady?()

            let segmentation = VadSegmentationConfig(
                minSpeechDuration: TimeInterval(config.minSpeechMs) / 1_000.0,
                minSilenceDuration: TimeInterval(config.minSilenceMs) / 1_000.0,
                maxSpeechDuration: 14.0,
                speechPadding: TimeInterval(config.speechPadMs) / 1_000.0
            )
            var state = VadStreamState.initial()

            for await chunk in stream {
                if Task.isCancelled { break }
                do {
                    let result = try await manager.processStreamingChunk(
                        chunk,
                        state: state,
                        config: segmentation,
                        returnSeconds: false
                    )
                    state = result.state
                    if let event = result.event {
                        switch event.kind {
                        case .speechStart:
                            self.onSpeechStart?(Double(result.probability))
                        case .speechEnd:
                            self.onSpeechEnd?(Double(result.probability))
                        }
                    }
                } catch {
                    sileroLogger.error(
                        "Silero processStreamingChunk failed: \(error.localizedDescription, privacy: .public)"
                    )
                    self.onError?("Silero processStreamingChunk failed: \(error.localizedDescription)")
                }
            }
        }
    }

    private func stopLocked() {
        guard isStarted else { return }
        isStarted = false
        chunkContinuation?.finish()
        chunkContinuation = nil
        chunkStream = nil
        processorTask?.cancel()
        processorTask = nil
        chunkBuffer.reset()
        converter = nil
        converterSourceFormat = nil
    }

    private func appendAndYieldChunks(_ samples: [Float]) {
        guard isStarted, let continuation = chunkContinuation else { return }
        for chunk in chunkBuffer.append(samples) {
            continuation.yield(chunk)
        }
    }

    private func resampleToSileroFormat(_ buffer: AVAudioPCMBuffer) -> [Float]? {
        let inputFormat = buffer.format
        if inputFormat.sampleRate == sileroFormat.sampleRate,
           inputFormat.channelCount == 1,
           inputFormat.commonFormat == .pcmFormatFloat32,
           let channelData = buffer.floatChannelData?[0] {
            // Already in the right shape; copy the active frame window.
            let frameCount = Int(buffer.frameLength)
            return Array(UnsafeBufferPointer(start: channelData, count: frameCount))
        }

        if converter == nil || converterSourceFormat?.isEqual(inputFormat) != true {
            converter = AVAudioConverter(from: inputFormat, to: sileroFormat)
            converterSourceFormat = inputFormat
        }
        guard let converter else { return nil }

        // Target capacity scales by the sample-rate ratio so an entire input
        // buffer fits in one converter pass.
        let outputCapacity = AVAudioFrameCount(
            ceil(Double(buffer.frameLength) * sileroFormat.sampleRate / inputFormat.sampleRate)
        ) + 32
        guard let outputBuffer = AVAudioPCMBuffer(
            pcmFormat: sileroFormat,
            frameCapacity: outputCapacity
        ) else {
            return nil
        }

        var error: NSError?
        var pulled = false
        let status = converter.convert(to: outputBuffer, error: &error) { _, outStatus in
            if pulled {
                outStatus.pointee = .endOfStream
                return nil
            }
            pulled = true
            outStatus.pointee = .haveData
            return buffer
        }
        if status == .error || error != nil {
            sileroLogger.error(
                "AVAudioConverter failed: \(error?.localizedDescription ?? "unknown", privacy: .public)"
            )
            return nil
        }

        guard let channelData = outputBuffer.floatChannelData?[0] else { return nil }
        let frameCount = Int(outputBuffer.frameLength)
        return Array(UnsafeBufferPointer(start: channelData, count: frameCount))
    }

    private static func makeChunkStream() -> (AsyncStream<[Float]>, AsyncStream<[Float]>.Continuation) {
        var continuation: AsyncStream<[Float]>.Continuation!
        // .unbounded so the audio thread never blocks; backpressure shows up
        // as memory growth, which the processor task drains as fast as the
        // ANE will let it (~256ms per chunk worst case, well above realtime).
        let stream = AsyncStream<[Float]>(bufferingPolicy: .unbounded) { cont in
            continuation = cont
        }
        return (stream, continuation)
    }
}
