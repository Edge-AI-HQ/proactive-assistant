import XCTest
@testable import AmbientAi

final class AudioStreamManagerSpeechBurstRoutingTests: XCTestCase {
    func testClassifierSpeechBurstRoutingAcceptsRmsFallbackOnly() {
        XCTAssertTrue(AudioStreamManager.acceptsClassifierSpeechBurst(source: "audio_vad_fallback"))
        XCTAssertFalse(AudioStreamManager.acceptsClassifierSpeechBurst(source: "sound_analysis"))
    }
}
