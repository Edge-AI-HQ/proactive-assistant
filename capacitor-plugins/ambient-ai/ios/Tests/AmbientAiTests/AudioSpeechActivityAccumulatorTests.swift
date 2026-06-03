import Foundation
import XCTest
@testable import AmbientAi

final class AudioSpeechActivityAccumulatorTests: XCTestCase {
    // 注意:Silero VAD v5 现在是语音触发的主门,SoundAnalysis 的 onSpeechBurst
    // 已经断开,fallback RMS 也常驻禁用。post-capture 这层只剩"丢掉完全死寂"
    // 的兜底,所以每帧阈值 (0.003 / 0.015) 和聚合判定 (frameCount>=1 OR
    // durationMs>=100) 都比之前宽很多。

    func testSpeechFrameRequiresBothRmsAndPeak() {
        // 每帧判定仍是 AND:rms 和 peak 都要过门槛,避免单个 spike 误判
        XCTAssertTrue(AudioSpeechActivityHeuristics.isSpeechLikeFrame(rms: 0.02, peak: 0.06))
    }

    func testHighPeakWithLowRmsIsNotSpeechLike() {
        // AND 下 rms 不够即拒绝,即便 peak 很高
        XCTAssertFalse(AudioSpeechActivityHeuristics.isSpeechLikeFrame(rms: 0.001, peak: 0.06))
    }

    func testQuietFrameDoesNotExtendRecording() {
        // 0.001 RMS / 0.01 peak 都低于新阈值 (0.003 / 0.015)
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

    func testShortQuietBurstIsAcceptedNowThatSileroGatesUpstream() {
        // Silero 已经在触发层确认这是语音才会开始 capture,所以 post-capture
        // 这层 100ms / amplitude 0.02 的小突发应该被接受 (peak 0.02 >= 0.015,
        // rms ≈ 0.014 >= 0.003,OR 判定下 frameCount=1 >= 1 满足)。这种短促
        // 应答词(比如"好的"、"嗯")是过去 24-字符过滤一起丢掉的主要受害者。
        var accumulator = AudioSpeechActivityAccumulator()

        accumulator.append(pcm: makePCM(durationMs: 100, amplitude: 0.02), durationMs: 100)

        let snapshot = accumulator.snapshot()
        XCTAssertTrue(snapshot.isSpeechLike)
    }

    // Pure-silence rejection is covered by `testSilenceIsNotSpeechLike`
    // above — that invariant survived the loosening unchanged.

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
