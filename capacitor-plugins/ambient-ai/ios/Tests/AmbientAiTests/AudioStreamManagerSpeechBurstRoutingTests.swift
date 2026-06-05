import XCTest
@testable import AmbientAi

final class AudioStreamManagerSpeechBurstRoutingTests: XCTestCase {
    func testClassifierSpeechBurstRoutingAcceptsRmsFallbackOnly() {
        XCTAssertTrue(AudioStreamManager.acceptsClassifierSpeechBurst(source: "audio_vad_fallback"))
        XCTAssertFalse(AudioStreamManager.acceptsClassifierSpeechBurst(source: "sound_analysis"))
    }

    func testCaptureSessionRotatedPayloadUsesStableWireFields() {
        let rotatedAt = Date(timeIntervalSince1970: 1_778_412_300.25)
        let record = CaptureSessionRotatedRecord(
            oldCaptureSessionId: "old-session",
            newCaptureSessionId: "new-session",
            reason: .idleGap,
            rotatedAt: rotatedAt,
            ageMs: 301_000,
            idleGapMs: 30_500
        )

        let payload = record.payload

        XCTAssertEqual(payload["oldCaptureSessionId"] as? String, "old-session")
        XCTAssertEqual(payload["newCaptureSessionId"] as? String, "new-session")
        XCTAssertEqual(payload["reason"] as? String, "idle_gap")
        XCTAssertEqual(payload["rotatedAt"] as? String, "2026-05-10T11:25:00.250Z")
        XCTAssertEqual(payload["ageMs"] as? Int, 301_000)
        XCTAssertEqual(payload["idleGapMs"] as? Int, 30_500)
    }
}
