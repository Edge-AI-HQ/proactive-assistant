import AVFoundation
import XCTest
@testable import AmbientAi

final class SoundClassificationServiceTests: XCTestCase {
    func testMicrophoneTapForwardsRawBufferToVad() {
        let service = SoundClassificationService()
        let buffer = makeBuffer()
        var forwardedBuffers = 0
        service.onAudioBuffer = { received in
            XCTAssertTrue(received === buffer)
            forwardedBuffers += 1
        }

        service.handleMicrophoneTap(
            buffer: buffer,
            atAudioFramePosition: 0,
            analyzeWithSoundAnalysis: true
        )

        XCTAssertEqual(forwardedBuffers, 1)
    }

    func testRmsFallbackCanTriggerWhileAnalyzerHasNotFailed() {
        let service = SoundClassificationService()
        let buffer = makeBuffer(amplitude: 0.04)
        var burst: (confidence: Double, source: String)?
        service.onSpeechBurst = { confidence, source in
            burst = (confidence, source)
        }

        service.handleMicrophoneTap(
            buffer: buffer,
            atAudioFramePosition: 0,
            analyzeWithSoundAnalysis: false
        )

        XCTAssertEqual(burst?.source, "audio_vad_fallback")
        XCTAssertGreaterThan(burst?.confidence ?? 0, 0)
    }

    private func makeBuffer(amplitude: Float = 0) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false
        )!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 160)!
        buffer.frameLength = 160
        if let channel = buffer.floatChannelData?[0] {
            for index in 0..<Int(buffer.frameLength) {
                channel[index] = amplitude
            }
        }
        return buffer
    }
}
