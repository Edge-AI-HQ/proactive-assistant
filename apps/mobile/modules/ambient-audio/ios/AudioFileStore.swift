import AVFoundation
import Foundation
import SQLite3

enum AudioCaptureListOrder: String {
    case asc
    case desc
}

actor AudioFileStore {
    private let directory: URL
    private let ledger: AudioCaptureLedger
    private var config: AudioCaptureConfig
    private var recentCaptures: [AudioCaptureMetadata] = []

    init(config: AudioCaptureConfig = .default, directory: URL? = nil) {
        self.config = config
        self.directory = directory ?? Self.audioDirectory()
        self.ledger = AudioCaptureLedger(databaseURL: Self.ledgerURL(for: self.directory))
        self.recentCaptures = Self.loadCaptures(from: self.directory, ledger: self.ledger)
    }

    func updateConfig(_ config: AudioCaptureConfig) {
        self.config = config
        enforceRetention()
    }

    func ensureDirectory() {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? ledger.ensure()
        Self.migrateLegacyCacheCaptures(to: directory)
        backfillLedgerFromSidecars()
    }

    func saveWav(
        pcmData: Data,
        burstId: String,
        captureSessionId: String,
        capturedAt: Date,
        durationMs: Int,
        triggerSource: String?,
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
            triggerSource: triggerSource,
            url: url
        )
        do {
            try ledger.upsert(metadata)
            try Self.writeSidecar(for: metadata)
        } catch {
            try? FileManager.default.removeItem(at: url)
            try? ledger.delete(wavId: wavId)
            throw error
        }
        upsert(metadata)
        enforceRetention()
        return metadata
    }

    func listRecentCaptures(
        limit: Int? = nil,
        cursor: String? = nil,
        order: AudioCaptureListOrder = .desc
    ) -> [AudioCaptureMetadata] {
        enforceRetention()
        let captures = (try? ledger.list(
            directory: directory,
            limit: limit,
            cursor: cursor,
            order: order
        )) ?? recentCaptures
        return captures
            .filter { FileManager.default.fileExists(atPath: $0.url.path) }
            .sorted { order == .asc ? $0.capturedAt < $1.capturedAt : $0.capturedAt > $1.capturedAt }
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
            removeCapture(metadata)
        } else {
            let directURL = directory.appendingPathComponent("\(wavId).wav")
            try? FileManager.default.removeItem(at: directURL)
            try? FileManager.default.removeItem(at: Self.sidecarURL(for: directURL))
            try? ledger.delete(wavId: wavId)
        }
        recentCaptures.removeAll { $0.wavId == wavId }
    }

    private func enforceRetention() {
        ensureDirectory()
        let now = Date()
        let ttl = TimeInterval(config.wavRetentionTtlMs) / 1_000.0
        let cutoff = now.addingTimeInterval(-ttl)
        recentCaptures = Self.mergeCaptures(memory: recentCaptures, directory: directory, ledger: ledger)

        var files = recentCaptures
            .filter { FileManager.default.fileExists(atPath: $0.url.path) }

        for capture in files where capture.capturedAt < cutoff {
            removeCapture(capture)
        }
        files = files.filter {
            $0.capturedAt >= cutoff && FileManager.default.fileExists(atPath: $0.url.path)
        }

        var sorted = files.sorted { $0.capturedAt < $1.capturedAt }
        while sorted.count > config.wavMaxFiles, let oldest = sorted.first {
            removeCapture(oldest)
            sorted.removeFirst()
        }

        var totalBytes = sorted.reduce(0) { $0 + $1.byteSize }
        while totalBytes > config.wavMaxBytes, let oldest = sorted.first {
            removeCapture(oldest)
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

    private func backfillLedgerFromSidecars() {
        for capture in Self.loadCapturesFromSidecars(from: directory) {
            try? ledger.upsert(capture)
        }
    }

    private static func audioDirectory() -> URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        return (appSupport ?? FileManager.default.temporaryDirectory)
            .appendingPathComponent("pin-ambient-ai/audio-captures", isDirectory: true)
    }

    private static func ledgerURL(for directory: URL) -> URL {
        let parent = directory.lastPathComponent == "audio-captures"
            ? directory.deletingLastPathComponent()
            : directory
        return parent.appendingPathComponent("audio-capture-ledger.sqlite")
    }

    private static func legacyAudioDirectory() -> URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        return (caches ?? FileManager.default.temporaryDirectory)
            .appendingPathComponent("pin-ambient-ai-audio", isDirectory: true)
    }

    private static func migrateLegacyCacheCaptures(to directory: URL) {
        let legacy = legacyAudioDirectory()
        guard legacy.path != directory.path,
              FileManager.default.fileExists(atPath: legacy.path),
              let urls = try? FileManager.default.contentsOfDirectory(
                at: legacy,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
              ) else {
            return
        }
        for url in urls where url.pathExtension == "wav" || url.pathExtension == "json" {
            let target = directory.appendingPathComponent(url.lastPathComponent)
            guard !FileManager.default.fileExists(atPath: target.path) else { continue }
            try? FileManager.default.copyItem(at: url, to: target)
        }
    }

    private static func mergeCaptures(
        memory: [AudioCaptureMetadata],
        directory: URL,
        ledger: AudioCaptureLedger? = nil
    ) -> [AudioCaptureMetadata] {
        let disk = loadCapturesFromSidecars(from: directory)
        for capture in disk {
            try? ledger?.upsert(capture)
        }
        let ledgerCaptures = (try? ledger?.list(directory: directory, limit: nil, cursor: nil, order: .desc)) ?? []
        var byId: [String: AudioCaptureMetadata] = [:]
        for capture in memory where FileManager.default.fileExists(atPath: capture.url.path) {
            byId[capture.wavId] = capture
        }
        for capture in ledgerCaptures where FileManager.default.fileExists(atPath: capture.url.path) {
            byId[capture.wavId] = capture
        }
        for capture in disk {
            byId[capture.wavId] = capture
        }
        return Array(byId.values)
    }

    private static func loadCaptures(from directory: URL, ledger: AudioCaptureLedger) -> [AudioCaptureMetadata] {
        try? ledger.ensure()
        return mergeCaptures(memory: [], directory: directory, ledger: ledger)
    }

    private static func loadCapturesFromSidecars(from directory: URL) -> [AudioCaptureMetadata] {
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
            triggerSource: nil,
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

    private func removeCapture(_ capture: AudioCaptureMetadata) {
        Self.removeCapture(capture)
        try? ledger.delete(wavId: capture.wavId)
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
    let triggerSource: String?

    init(metadata: AudioCaptureMetadata) {
        wavId = metadata.wavId
        burstId = metadata.burstId
        captureSessionId = metadata.captureSessionId
        capturedAt = Self.iso8601.string(from: metadata.capturedAt)
        durationMs = metadata.durationMs
        byteSize = metadata.byteSize
        triggerSource = metadata.triggerSource
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
            triggerSource: triggerSource,
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

private final class AudioCaptureLedger {
    private let databaseURL: URL
    private var db: OpaquePointer?

    init(databaseURL: URL) {
        self.databaseURL = databaseURL
    }

    deinit {
        if let db {
            sqlite3_close(db)
        }
    }

    func ensure() throws {
        if db == nil {
            try FileManager.default.createDirectory(
                at: databaseURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            var opened: OpaquePointer?
            let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
            guard sqlite3_open_v2(databaseURL.path, &opened, flags, nil) == SQLITE_OK,
                  let opened else {
                throw LedgerError.open(String(cString: sqlite3_errmsg(opened)))
            }
            db = opened
        }
        try execute("""
        CREATE TABLE IF NOT EXISTS audio_capture_ledger (
            wav_id TEXT PRIMARY KEY,
            burst_id TEXT NOT NULL,
            capture_session_id TEXT NOT NULL,
            captured_at TEXT NOT NULL,
            duration_ms INTEGER NOT NULL,
            byte_size INTEGER NOT NULL,
            trigger_source TEXT,
            file_name TEXT NOT NULL,
            processed_at TEXT
        )
        """)
        try execute("""
        CREATE INDEX IF NOT EXISTS idx_audio_capture_ledger_pending_captured_at
        ON audio_capture_ledger(processed_at, captured_at)
        """)
    }

    func upsert(_ metadata: AudioCaptureMetadata) throws {
        try ensure()
        let sql = """
        INSERT INTO audio_capture_ledger (
            wav_id,
            burst_id,
            capture_session_id,
            captured_at,
            duration_ms,
            byte_size,
            trigger_source,
            file_name,
            processed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(wav_id) DO UPDATE SET
            burst_id = excluded.burst_id,
            capture_session_id = excluded.capture_session_id,
            captured_at = excluded.captured_at,
            duration_ms = excluded.duration_ms,
            byte_size = excluded.byte_size,
            trigger_source = excluded.trigger_source,
            file_name = excluded.file_name,
            processed_at = NULL
        """
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        bindText(statement, 1, metadata.wavId)
        bindText(statement, 2, metadata.burstId)
        bindText(statement, 3, metadata.captureSessionId)
        bindText(statement, 4, Self.iso8601.string(from: metadata.capturedAt))
        sqlite3_bind_int(statement, 5, Int32(metadata.durationMs))
        sqlite3_bind_int(statement, 6, Int32(metadata.byteSize))
        bindText(statement, 7, metadata.triggerSource)
        bindText(statement, 8, metadata.url.lastPathComponent)
        try stepDone(statement)
    }

    func list(
        directory: URL,
        limit: Int?,
        cursor: String?,
        order: AudioCaptureListOrder
    ) throws -> [AudioCaptureMetadata] {
        try ensure()
        let sanitizedLimit = max(
            1,
            min(limit ?? AudioCaptureConfig.defaultWavMaxFiles, AudioCaptureConfig.defaultWavMaxFiles)
        )
        var sql = """
        SELECT wav_id, burst_id, capture_session_id, captured_at, duration_ms, byte_size, trigger_source, file_name
        FROM audio_capture_ledger
        WHERE processed_at IS NULL
        """
        if cursor != nil {
            sql += order == .asc ? " AND captured_at > ?" : " AND captured_at < ?"
        }
        sql += " ORDER BY captured_at \(order == .asc ? "ASC" : "DESC") LIMIT ?"

        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        var nextIndex: Int32 = 1
        if let cursor {
            bindText(statement, nextIndex, cursor)
            nextIndex += 1
        }
        sqlite3_bind_int(statement, nextIndex, Int32(sanitizedLimit))

        var captures: [AudioCaptureMetadata] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            guard let wavId = columnText(statement, 0),
                  let burstId = columnText(statement, 1),
                  let captureSessionId = columnText(statement, 2),
                  let capturedAtText = columnText(statement, 3),
                  let capturedAt = Self.iso8601.date(from: capturedAtText),
                  let fileName = columnText(statement, 7) else {
                continue
            }
            let durationMs = Int(sqlite3_column_int(statement, 4))
            let byteSize = Int(sqlite3_column_int(statement, 5))
            let triggerSource = columnText(statement, 6)
            captures.append(AudioCaptureMetadata(
                wavId: wavId,
                burstId: burstId,
                captureSessionId: captureSessionId,
                capturedAt: capturedAt,
                durationMs: durationMs,
                byteSize: byteSize,
                triggerSource: triggerSource,
                url: directory.appendingPathComponent(fileName)
            ))
        }
        return captures
    }

    func delete(wavId: String) throws {
        try ensure()
        let statement = try prepare("DELETE FROM audio_capture_ledger WHERE wav_id = ?")
        defer { sqlite3_finalize(statement) }
        bindText(statement, 1, wavId)
        try stepDone(statement)
    }

    private func execute(_ sql: String) throws {
        guard let db else { throw LedgerError.open("database is not open") }
        var error: UnsafeMutablePointer<Int8>?
        guard sqlite3_exec(db, sql, nil, nil, &error) == SQLITE_OK else {
            let message = error.map { String(cString: $0) } ?? "unknown sqlite error"
            sqlite3_free(error)
            throw LedgerError.execute(message)
        }
    }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        guard let db else { throw LedgerError.open("database is not open") }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK,
              let statement else {
            throw LedgerError.execute(String(cString: sqlite3_errmsg(db)))
        }
        return statement
    }

    private func stepDone(_ statement: OpaquePointer) throws {
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw LedgerError.execute(errorMessage())
        }
    }

    private func errorMessage() -> String {
        guard let db else { return "database is not open" }
        return String(cString: sqlite3_errmsg(db))
    }

    private func bindText(_ statement: OpaquePointer, _ index: Int32, _ value: String?) {
        guard let value else {
            sqlite3_bind_null(statement, index)
            return
        }
        sqlite3_bind_text(statement, index, value, -1, Self.sqliteTransient)
    }

    private func columnText(_ statement: OpaquePointer, _ index: Int32) -> String? {
        guard let pointer = sqlite3_column_text(statement, index) else { return nil }
        return String(cString: pointer)
    }

    private enum LedgerError: Error {
        case open(String)
        case execute(String)
    }

    private static let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
