import AVFoundation
import Foundation

actor AudioFileStore {
    private let directory: URL
    private var config: AudioCaptureConfig
    private var recentCaptures: [AudioCaptureMetadata] = []

    init(config: AudioCaptureConfig = .default, directory: URL? = nil) {
        self.config = config
        self.directory = directory ?? Self.audioDirectory()
        self.recentCaptures = Self.loadCaptures(from: self.directory)
    }

    func updateConfig(_ config: AudioCaptureConfig) {
        self.config = config
        enforceRetention()
    }

    func ensureDirectory() {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    func saveWav(
        pcmData: Data,
        burstId: String,
        captureSessionId: String,
        capturedAt: Date,
        durationMs: Int,
        sampleRate: UInt32,
        channels: UInt16
    ) throws -> AudioCaptureMetadata {
        ensureDirectory()
        let wavId = UUID().uuidString
        let url = directory.appendingPathComponent("\(wavId).wav")
        let wav = Self.makeWavHeader(
            dataLength: UInt32(pcmData.count),
            sampleRate: sampleRate,
            channels: channels
        ) + pcmData
        try wav.write(to: url, options: .atomic)

        let metadata = AudioCaptureMetadata(
            wavId: wavId,
            burstId: burstId,
            captureSessionId: captureSessionId,
            capturedAt: capturedAt,
            durationMs: durationMs,
            byteSize: wav.count,
            url: url
        )
        do {
            try Self.writeSidecar(for: metadata)
        } catch {
            try? FileManager.default.removeItem(at: url)
            throw error
        }
        upsert(metadata)
        enforceRetention()
        return metadata
    }

    func listRecentCaptures() -> [AudioCaptureMetadata] {
        enforceRetention()
        return recentCaptures
            .filter { FileManager.default.fileExists(atPath: $0.url.path) }
            .sorted { $0.capturedAt > $1.capturedAt }
    }

    func resolveURL(wavId: String) -> URL? {
        enforceRetention()
        if let metadata = recentCaptures.first(where: { $0.wavId == wavId }),
           FileManager.default.fileExists(atPath: metadata.url.path) {
            return metadata.url
        }
        let directURL = directory.appendingPathComponent("\(wavId).wav")
        guard FileManager.default.fileExists(atPath: directURL.path) else { return nil }
        return directURL
    }

    func markCaptureProcessed(wavId: String) {
        enforceRetention()
        if let metadata = recentCaptures.first(where: { $0.wavId == wavId }) {
            Self.removeCapture(metadata)
        } else {
            let directURL = directory.appendingPathComponent("\(wavId).wav")
            try? FileManager.default.removeItem(at: directURL)
            try? FileManager.default.removeItem(at: Self.sidecarURL(for: directURL))
        }
        recentCaptures.removeAll { $0.wavId == wavId }
    }

    private func enforceRetention() {
        ensureDirectory()
        let now = Date()
        let ttl = TimeInterval(config.wavRetentionTtlMs) / 1_000.0
        let cutoff = now.addingTimeInterval(-ttl)
        recentCaptures = Self.mergeCaptures(memory: recentCaptures, directory: directory)

        var files = recentCaptures
            .filter { FileManager.default.fileExists(atPath: $0.url.path) }

        for capture in files where capture.capturedAt < cutoff {
            Self.removeCapture(capture)
        }
        files = files.filter {
            $0.capturedAt >= cutoff && FileManager.default.fileExists(atPath: $0.url.path)
        }

        var sorted = files.sorted { $0.capturedAt < $1.capturedAt }
        while sorted.count > config.wavMaxFiles, let oldest = sorted.first {
            Self.removeCapture(oldest)
            sorted.removeFirst()
        }

        var totalBytes = sorted.reduce(0) { $0 + $1.byteSize }
        while totalBytes > config.wavMaxBytes, let oldest = sorted.first {
            Self.removeCapture(oldest)
            totalBytes -= oldest.byteSize
            sorted.removeFirst()
        }

        let aliveIds = Set(sorted.map(\.wavId))
        recentCaptures = sorted.filter { aliveIds.contains($0.wavId) }
    }

    private func upsert(_ metadata: AudioCaptureMetadata) {
        recentCaptures.removeAll { $0.wavId == metadata.wavId }
        recentCaptures.append(metadata)
    }

    private static func audioDirectory() -> URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        return (caches ?? FileManager.default.temporaryDirectory)
            .appendingPathComponent("pin-ambient-ai-audio", isDirectory: true)
    }

    private static func mergeCaptures(
        memory: [AudioCaptureMetadata],
        directory: URL
    ) -> [AudioCaptureMetadata] {
        let disk = loadCaptures(from: directory)
        var byId: [String: AudioCaptureMetadata] = [:]
        for capture in memory where FileManager.default.fileExists(atPath: capture.url.path) {
            byId[capture.wavId] = capture
        }
        for capture in disk {
            byId[capture.wavId] = capture
        }
        return Array(byId.values)
    }

    private static func loadCaptures(from directory: URL) -> [AudioCaptureMetadata] {
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        return urls
            .filter { $0.pathExtension == "wav" }
            .compactMap { url in
                if let sidecar = readSidecar(for: url) {
                    return sidecar
                }
                guard let recovered = recoverMetadata(for: url) else { return nil }
                try? writeSidecar(for: recovered)
                return recovered
            }
    }

    private static func readSidecar(for wavURL: URL) -> AudioCaptureMetadata? {
        let sidecarURL = sidecarURL(for: wavURL)
        guard let data = try? Data(contentsOf: sidecarURL),
              let sidecar = try? JSONDecoder().decode(AudioCaptureSidecar.self, from: data) else {
            return nil
        }
        return sidecar.metadata(wavURL: wavURL)
    }

    private static func writeSidecar(for metadata: AudioCaptureMetadata) throws {
        let sidecar = AudioCaptureSidecar(metadata: metadata)
        let data = try JSONEncoder().encode(sidecar)
        try data.write(to: sidecarURL(for: metadata.url), options: .atomic)
    }

    private static func recoverMetadata(for wavURL: URL) -> AudioCaptureMetadata? {
        let wavId = wavURL.deletingPathExtension().lastPathComponent
        guard !wavId.isEmpty else { return nil }
        let attributes = try? FileManager.default.attributesOfItem(atPath: wavURL.path)
        let capturedAt = attributes?[.modificationDate] as? Date ?? Date()
        let byteSize = attributes?[.size] as? Int ?? ((try? Data(contentsOf: wavURL).count) ?? 0)
        return AudioCaptureMetadata(
            wavId: wavId,
            burstId: "recovered-\(wavId)",
            captureSessionId: "recovered-\(wavId)",
            capturedAt: capturedAt,
            durationMs: durationMs(for: wavURL),
            byteSize: byteSize,
            url: wavURL
        )
    }

    private static func durationMs(for wavURL: URL) -> Int {
        guard let file = try? AVAudioFile(forReading: wavURL) else { return 0 }
        let sampleRate = file.processingFormat.sampleRate
        guard sampleRate > 0 else { return 0 }
        return Int((Double(file.length) / sampleRate) * 1_000)
    }

    private static func removeCapture(_ capture: AudioCaptureMetadata) {
        try? FileManager.default.removeItem(at: capture.url)
        try? FileManager.default.removeItem(at: sidecarURL(for: capture.url))
    }

    private static func sidecarURL(for wavURL: URL) -> URL {
        wavURL.deletingPathExtension().appendingPathExtension("json")
    }

    static func makeWavHeader(
        dataLength: UInt32,
        sampleRate: UInt32,
        channels: UInt16
    ) -> Data {
        let bitsPerSample: UInt16 = 16
        let byteRate = sampleRate * UInt32(bitsPerSample) * UInt32(channels) / 8
        let blockAlign: UInt16 = bitsPerSample * channels / 8

        var header = Data(capacity: 44)
        header.append(contentsOf: [0x52, 0x49, 0x46, 0x46])
        header.appendUInt32LE(36 + dataLength)
        header.append(contentsOf: [0x57, 0x41, 0x56, 0x45])
        header.append(contentsOf: [0x66, 0x6D, 0x74, 0x20])
        header.appendUInt32LE(16)
        header.appendUInt16LE(1)
        header.appendUInt16LE(channels)
        header.appendUInt32LE(sampleRate)
        header.appendUInt32LE(byteRate)
        header.appendUInt16LE(blockAlign)
        header.appendUInt16LE(bitsPerSample)
        header.append(contentsOf: [0x64, 0x61, 0x74, 0x61])
        header.appendUInt32LE(dataLength)
        return header
    }
}

private struct AudioCaptureSidecar: Codable {
    let wavId: String
    let burstId: String
    let captureSessionId: String
    let capturedAt: String
    let durationMs: Int
    let byteSize: Int

    init(metadata: AudioCaptureMetadata) {
        wavId = metadata.wavId
        burstId = metadata.burstId
        captureSessionId = metadata.captureSessionId
        capturedAt = Self.iso8601.string(from: metadata.capturedAt)
        durationMs = metadata.durationMs
        byteSize = metadata.byteSize
    }

    func metadata(wavURL: URL) -> AudioCaptureMetadata? {
        guard let date = Self.iso8601.date(from: capturedAt) else { return nil }
        return AudioCaptureMetadata(
            wavId: wavId,
            burstId: burstId,
            captureSessionId: captureSessionId,
            capturedAt: date,
            durationMs: durationMs,
            byteSize: byteSize,
            url: wavURL
        )
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

private extension Data {
    mutating func appendUInt32LE(_ value: UInt32) {
        var little = value.littleEndian
        append(Data(bytes: &little, count: 4))
    }

    mutating func appendUInt16LE(_ value: UInt16) {
        var little = value.littleEndian
        append(Data(bytes: &little, count: 2))
    }
}
