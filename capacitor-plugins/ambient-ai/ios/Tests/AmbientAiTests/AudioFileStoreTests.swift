import Foundation
import XCTest
@testable import AmbientAi

final class AudioFileStoreTests: XCTestCase {
    func testProcessedCaptureIsRemovedAfterSidecarReload() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("AudioFileStoreTests-\(UUID().uuidString)", isDirectory: true)
        defer {
            try? FileManager.default.removeItem(at: directory)
        }

        let store = AudioFileStore(config: .default, directory: directory)
        await store.ensureDirectory()
        let metadata = try await store.saveWav(
            pcmData: Data(repeating: 0, count: 3_200),
            burstId: "burst-test",
            captureSessionId: "session-test",
            capturedAt: Date(),
            durationMs: 100,
            triggerSource: "test",
            sampleRate: 16_000,
            channels: 1
        )

        let reloaded = AudioFileStore(config: .default, directory: directory)
        let captures = await reloaded.listRecentCaptures()
        XCTAssertEqual(captures.map(\.wavId), [metadata.wavId])
        XCTAssertEqual(captures.first?.triggerSource, "test")
        XCTAssertTrue(FileManager.default.fileExists(atPath: metadata.url.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: metadata.url.deletingPathExtension().appendingPathExtension("json").path))

        await reloaded.markCaptureProcessed(wavId: metadata.wavId)

        let remaining = await reloaded.listRecentCaptures()
        XCTAssertTrue(remaining.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: metadata.url.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: metadata.url.deletingPathExtension().appendingPathExtension("json").path))
    }

    func testLedgerKeepsPendingCaptureAfterSidecarLoss() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("AudioFileStoreTests-\(UUID().uuidString)", isDirectory: true)
        defer {
            try? FileManager.default.removeItem(at: directory)
        }

        let store = AudioFileStore(config: .default, directory: directory)
        await store.ensureDirectory()
        let metadata = try await store.saveWav(
            pcmData: Data(repeating: 0, count: 3_200),
            burstId: "burst-ledger",
            captureSessionId: "session-ledger",
            capturedAt: Date(timeIntervalSince1970: 1_777_000_000),
            durationMs: 100,
            triggerSource: "background_continuous",
            sampleRate: 16_000,
            channels: 1
        )
        try FileManager.default.removeItem(
            at: metadata.url.deletingPathExtension().appendingPathExtension("json")
        )

        let reloaded = AudioFileStore(config: .default, directory: directory)
        let captures = await reloaded.listRecentCaptures()

        XCTAssertEqual(captures.map(\.wavId), [metadata.wavId])
        XCTAssertEqual(captures.first?.burstId, "burst-ledger")
        XCTAssertEqual(captures.first?.captureSessionId, "session-ledger")
        XCTAssertEqual(captures.first?.triggerSource, "background_continuous")
        XCTAssertTrue(FileManager.default.fileExists(atPath: metadata.url.path))

        await reloaded.markCaptureProcessed(wavId: metadata.wavId)

        let finalCaptures = await reloaded.listRecentCaptures()
        XCTAssertTrue(finalCaptures.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: metadata.url.path))
    }

    func testListRecentCapturesSupportsPagingAndOrder() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("AudioFileStoreTests-\(UUID().uuidString)", isDirectory: true)
        defer {
            try? FileManager.default.removeItem(at: directory)
        }

        let store = AudioFileStore(config: .default, directory: directory)
        await store.ensureDirectory()
        _ = try await store.saveWav(
            pcmData: Data(repeating: 0, count: 3_200),
            burstId: "burst-old",
            captureSessionId: "session-paged",
            capturedAt: Date(timeIntervalSince1970: 1_777_000_000),
            durationMs: 100,
            triggerSource: "background_continuous",
            sampleRate: 16_000,
            channels: 1
        )
        let middle = try await store.saveWav(
            pcmData: Data(repeating: 0, count: 3_200),
            burstId: "burst-middle",
            captureSessionId: "session-paged",
            capturedAt: Date(timeIntervalSince1970: 1_777_000_100),
            durationMs: 100,
            triggerSource: "background_continuous",
            sampleRate: 16_000,
            channels: 1
        )
        let newest = try await store.saveWav(
            pcmData: Data(repeating: 0, count: 3_200),
            burstId: "burst-newest",
            captureSessionId: "session-paged",
            capturedAt: Date(timeIntervalSince1970: 1_777_000_200),
            durationMs: 100,
            triggerSource: "background_continuous",
            sampleRate: 16_000,
            channels: 1
        )

        let firstPage = await store.listRecentCaptures(limit: 2, order: .desc)
        XCTAssertEqual(firstPage.map(\.wavId), [newest.wavId, middle.wavId])

        let secondPage = await store.listRecentCaptures(
            limit: 2,
            cursor: iso8601(middle.capturedAt),
            order: .desc
        )
        XCTAssertEqual(secondPage.map(\.burstId), ["burst-old"])

        let ascending = await store.listRecentCaptures(limit: 2, order: .asc)
        XCTAssertEqual(ascending.map(\.burstId), ["burst-old", "burst-middle"])
    }

    private func iso8601(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
