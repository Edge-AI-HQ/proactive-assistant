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
            sampleRate: 16_000,
            channels: 1
        )

        let reloaded = AudioFileStore(config: .default, directory: directory)
        let captures = await reloaded.listRecentCaptures()
        XCTAssertEqual(captures.map(\.wavId), [metadata.wavId])
        XCTAssertTrue(FileManager.default.fileExists(atPath: metadata.url.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: metadata.url.deletingPathExtension().appendingPathExtension("json").path))

        await reloaded.markCaptureProcessed(wavId: metadata.wavId)

        let remaining = await reloaded.listRecentCaptures()
        XCTAssertTrue(remaining.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: metadata.url.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: metadata.url.deletingPathExtension().appendingPathExtension("json").path))
    }
}
