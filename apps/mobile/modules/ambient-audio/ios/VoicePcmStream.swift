import AVFoundation
import Foundation

/// Independent chat-voice PCM stream.
///
/// This intentionally does not use AudioStreamManager's capture cycle: chat
/// dictation holds the external-mic lease, so ambient is suppressed while this
/// small AVAudioEngine owns the microphone. The stream only emits PCM chunks
/// for `/voice/transcribe-stream`; it never writes WAV captures or ambient
/// timeline events.
final class VoicePcmStream {
    typealias EmitChunk = ([String: Any]) -> Void

    private let emitChunk: EmitChunk
    private let lock = NSLock()
    private var engine: AVAudioEngine?
    private var streamId: String?
    private var sequence = 0
    private var pending = Data()
    private var targetSampleRate = 16_000
    private var chunkBytes = 3_200

    init(emitChunk: @escaping EmitChunk) {
        self.emitChunk = emitChunk
    }

    deinit {
        stop(streamId: nil)
    }

    func start(sampleRate: Int, chunkDurationMs: Int) throws -> String {
        stop(streamId: nil)

        let resolvedSampleRate = max(8_000, min(48_000, sampleRate))
        let resolvedChunkMs = max(20, min(500, chunkDurationMs))
        let resolvedChunkBytes = max(2, (resolvedSampleRate * 2 * resolvedChunkMs) / 1_000)
        let nextStreamId = UUID().uuidString

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .measurement,
            options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
        )
        try session.setActive(true, options: [])

        let nextEngine = AVAudioEngine()
        let inputNode = nextEngine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)
        guard inputFormat.channelCount > 0 else {
            throw VoicePcmStreamError.unavailableInput
        }

        lock.lock()
        streamId = nextStreamId
        sequence = 0
        pending.removeAll(keepingCapacity: true)
        targetSampleRate = resolvedSampleRate
        chunkBytes = resolvedChunkBytes
        lock.unlock()

        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: inputFormat) { [weak self] buffer, _ in
            self?.append(buffer: buffer, streamId: nextStreamId)
        }
        nextEngine.prepare()
        try nextEngine.start()

        lock.lock()
        engine = nextEngine
        lock.unlock()

        return nextStreamId
    }

    func stop(streamId requestedStreamId: String?) {
        let stoppedEngine: AVAudioEngine?
        let stoppedStreamId: String?
        let finalChunk: Data?
        let finalSequence: Int
        let sampleRate: Int

        lock.lock()
        if let requestedStreamId, requestedStreamId != streamId {
            lock.unlock()
            return
        }
        stoppedEngine = engine
        stoppedStreamId = streamId
        finalChunk = pending.isEmpty ? nil : pending
        finalSequence = sequence
        sampleRate = targetSampleRate
        engine = nil
        streamId = nil
        sequence = 0
        pending.removeAll(keepingCapacity: false)
        lock.unlock()

        if let stoppedEngine {
            stoppedEngine.inputNode.removeTap(onBus: 0)
            stoppedEngine.stop()
        }
        if let stoppedStreamId, let finalChunk {
            emit(
                pcm: finalChunk,
                streamId: stoppedStreamId,
                sequence: finalSequence,
                sampleRate: sampleRate
            )
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    private func append(buffer: AVAudioPCMBuffer, streamId expectedStreamId: String) {
        lock.lock()
        let sampleRate = targetSampleRate
        lock.unlock()

        guard let converted = Self.convert(buffer, targetSampleRate: sampleRate) else { return }

        var chunks: [(Data, String, Int, Int)] = []
        lock.lock()
        guard expectedStreamId == streamId else {
            lock.unlock()
            return
        }
        pending.append(converted)
        while pending.count >= chunkBytes {
            let chunk = Data(pending.prefix(chunkBytes))
            pending.removeFirst(chunkBytes)
            chunks.append((chunk, expectedStreamId, sequence, targetSampleRate))
            sequence += 1
        }
        lock.unlock()

        for (chunk, id, seq, rate) in chunks {
            emit(pcm: chunk, streamId: id, sequence: seq, sampleRate: rate)
        }
    }

    private func emit(pcm: Data, streamId: String, sequence: Int, sampleRate: Int) {
        let durationMs = Int((Double(pcm.count) / Double(max(1, sampleRate * 2))) * 1_000.0)
        emitChunk([
            "streamId": streamId,
            "sequence": sequence,
            "base64": pcm.base64EncodedString(),
            "byteSize": pcm.count,
            "durationMs": durationMs,
            "sampleRate": sampleRate,
            "channels": 1,
        ])
    }

    private static func convert(_ buffer: AVAudioPCMBuffer, targetSampleRate: Int) -> Data? {
        guard let channelData = buffer.floatChannelData else { return nil }
        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0 else { return nil }
        let inputSampleRate = buffer.format.sampleRate
        guard inputSampleRate > 0 else { return nil }

        let source = channelData[0]
        let outputFrameCount: Int
        if inputSampleRate == Double(targetSampleRate) {
            outputFrameCount = frameCount
        } else {
            outputFrameCount = max(
                1,
                Int((Double(frameCount) * Double(targetSampleRate)) / inputSampleRate)
            )
        }
        var data = Data(capacity: outputFrameCount * 2)

        for index in 0..<outputFrameCount {
            let sample: Float
            if inputSampleRate == Double(targetSampleRate) {
                sample = source[index]
            } else {
                let position = (Double(index) * inputSampleRate) / Double(targetSampleRate)
                let leftIndex = min(frameCount - 1, Int(position.rounded(.down)))
                let rightIndex = min(frameCount - 1, leftIndex + 1)
                let weight = Float(position - Double(leftIndex))
                sample = source[leftIndex] * (1 - weight) + source[rightIndex] * weight
            }
            let clamped = Swift.max(Float(-1.0), Swift.min(Float(1.0), sample))
            let intValue = Int16(clamping: Int(clamped * 32_767.0))
            var little = intValue.littleEndian
            data.append(Data(bytes: &little, count: 2))
        }

        return data
    }
}

private enum VoicePcmStreamError: LocalizedError {
    case unavailableInput

    var errorDescription: String? {
        switch self {
        case .unavailableInput:
            return "Microphone input is unavailable"
        }
    }
}
