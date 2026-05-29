import Foundation
import XCTest
@testable import AmbientAi

final class AudioSpeechActivityAccumulatorTests: XCTestCase {
    func testSpeechFrameRequiresBothRmsAndPeak() {
        // 中等收紧后改用 AND:rms 与 peak 都要过门槛才算语音帧
        XCTAssertTrue(AudioSpeechActivityHeuristics.isSpeechLikeFrame(rms: 0.02, peak: 0.06))
    }

    func testHighPeakWithLowRmsIsNotSpeechLike() {
        // 旧 OR 逻辑会因单个高 peak 通过;AND 下 rms 不够即拒绝
        XCTAssertFalse(AudioSpeechActivityHeuristics.isSpeechLikeFrame(rms: 0.001, peak: 0.06))
    }

    func testQuietFrameDoesNotExtendRecording() {
        XCTAssertFalse(AudioSpeechActivityHeuristics.isSpeechLikeFrame(rms: 0.001, peak: 0.01))
    }

    func testBackgroundContinuousStopsAfterPostRollSilence() {
        let config = AudioCaptureConfig(
            postRollMs: 2_500,
            maxBurstMs: 12_000,
            minBurstMs: 600
        )

        XCTAssertTrue(AudioCaptureCyclePolicy.shouldStopForSilence(
            triggerSource: "background_continuous",
            elapsedMs: 3_100,
            silenceMs: 2_500,
            config: config
        ))
    }

    func testCaptureDoesNotStopBeforeMinBurstEvenIfSilent() {
        let config = AudioCaptureConfig(
            postRollMs: 2_500,
            maxBurstMs: 12_000,
            minBurstMs: 600
        )

        XCTAssertFalse(AudioCaptureCyclePolicy.shouldStopForSilence(
            triggerSource: "background_continuous",
            elapsedMs: 500,
            silenceMs: 2_500,
            config: config
        ))
    }

    func testCaptureDoesNotStopBeforePostRollSilence() {
        let config = AudioCaptureConfig(
            postRollMs: 2_500,
            maxBurstMs: 12_000,
            minBurstMs: 600
        )

        XCTAssertFalse(AudioCaptureCyclePolicy.shouldStopForSilence(
            triggerSource: "sound_analysis",
            elapsedMs: 3_100,
            silenceMs: 2_499,
            config: config
        ))
    }

    func testSilenceIsNotSpeechLike() {
        var accumulator = AudioSpeechActivityAccumulator()

        accumulator.append(pcm: makePCM(durationMs: 1_000, amplitude: 0), durationMs: 1_000)

        let snapshot = accumulator.snapshot()
        XCTAssertFalse(snapshot.isSpeechLike)
        XCTAssertEqual(snapshot.speechLikeFrameCount, 0)
        XCTAssertEqual(snapshot.speechLikeDurationMs, 0)
        XCTAssertEqual(snapshot.rms, 0, accuracy: 0.001)
        XCTAssertEqual(snapshot.peak, 0, accuracy: 0.001)
    }

    func testShortQuietBurstIsRejected() {
        // 中等收紧:100ms 的弱突发(peak < 0.05 或时长不足 300ms)不再算语音,过滤细微噪声
        var accumulator = AudioSpeechActivityAccumulator()

        accumulator.append(pcm: makePCM(durationMs: 100, amplitude: 0.02), durationMs: 100)

        let snapshot = accumulator.snapshot()
        XCTAssertFalse(snapshot.isSpeechLike)
    }

    func testSustainedAudioIsSpeechLike() {
        var accumulator = AudioSpeechActivityAccumulator()

        accumulator.append(pcm: makePCM(durationMs: 500, amplitude: 0.12), durationMs: 500)

        let snapshot = accumulator.snapshot()
        XCTAssertTrue(snapshot.isSpeechLike)
        XCTAssertGreaterThanOrEqual(snapshot.speechLikeFrameCount, AudioSpeechActivityAccumulator.minSpeechLikeFrameCount)
        XCTAssertGreaterThanOrEqual(snapshot.speechLikeDurationMs, AudioSpeechActivityAccumulator.minSpeechLikeDurationMs)
        XCTAssertGreaterThan(snapshot.rms, AudioSpeechActivityAccumulator.speechRmsThreshold)
        XCTAssertGreaterThan(snapshot.peak, AudioSpeechActivityAccumulator.speechPeakThreshold)
    }

    private func makePCM(durationMs: Int, amplitude: Double, sampleRate: Int = 16_000) -> Data {
        let sampleCount = max(1, sampleRate * durationMs / 1_000)
        var data = Data(capacity: sampleCount * MemoryLayout<Int16>.size)
        for index in 0..<sampleCount {
            let phase = 2.0 * Double.pi * 440.0 * Double(index) / Double(sampleRate)
            let sample = max(-1.0, min(1.0, sin(phase) * amplitude))
            var little = Int16(clamping: Int(sample * 32_767.0)).littleEndian
            data.append(Data(bytes: &little, count: MemoryLayout<Int16>.size))
        }
        return data
    }
}
