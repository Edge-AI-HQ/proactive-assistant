import Foundation

actor AudioFileStore {
    private let directory: URL
    private var config: AudioCaptureConfig
    private var recentCaptures: [AudioCaptureMetadata] = []

    init(config: AudioCaptureConfig = .default) {
        self.config = config
        self.directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("pin-ambient-ai-audio", isDirectory: true)
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
        recentCaptures.append(metadata)
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
        guard let metadata = recentCaptures.first(where: { $0.wavId == wavId }),
              FileManager.default.fileExists(atPath: metadata.url.path) else {
            return nil
        }
        return metadata.url
    }

    private func enforceRetention() {
        ensureDirectory()
        let now = Date()
        let ttl = TimeInterval(config.wavRetentionTtlMs) / 1_000.0
        let cutoff = now.addingTimeInterval(-ttl)
        let knownPaths = Set(recentCaptures.map { $0.url.path })
        let diskWavs = (try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        )) ?? []
        for url in diskWavs where url.pathExtension == "wav" && !knownPaths.contains(url.path) {
            try? FileManager.default.removeItem(at: url)
        }

        var files = recentCaptures
            .filter { FileManager.default.fileExists(atPath: $0.url.path) }

        for capture in files where capture.capturedAt < cutoff {
            try? FileManager.default.removeItem(at: capture.url)
        }
        files = files.filter {
            $0.capturedAt >= cutoff && FileManager.default.fileExists(atPath: $0.url.path)
        }

        var sorted = files.sorted { $0.capturedAt < $1.capturedAt }
        while sorted.count > config.wavMaxFiles, let oldest = sorted.first {
            try? FileManager.default.removeItem(at: oldest.url)
            sorted.removeFirst()
        }

        var totalBytes = sorted.reduce(0) { $0 + $1.byteSize }
        while totalBytes > config.wavMaxBytes, let oldest = sorted.first {
            try? FileManager.default.removeItem(at: oldest.url)
            totalBytes -= oldest.byteSize
            sorted.removeFirst()
        }

        let aliveIds = Set(sorted.map(\.wavId))
        recentCaptures = recentCaptures.filter { aliveIds.contains($0.wavId) }
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
