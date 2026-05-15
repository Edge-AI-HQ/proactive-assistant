import Foundation

enum AudioSuppressedReason: String, Hashable {
    case media
    case playback
    case interruption
}

enum AudioTranscriptProvider: String {
    case localSpeech = "local_speech"
    case cloudWhisper = "cloud_whisper"
}

enum AudioEngineState: String {
    case stopped
    case starting
    case healthy
    case stale
    case failed
    case suspended
    case suppressed
    case restarting
}

enum AudioLocalSpeechProvider: String {
    case sfSpeech = "sfspeech"
}

struct AudioCaptureSnapshot {
    let running: Bool
    let paused: Bool
    let capturing: Bool
    let classificationRunning: Bool
    let engineRunning: Bool
    let capturePipelineRunning: Bool
    let engineState: AudioEngineState
    let lastClassificationAt: Date?
    let lastAudioError: String?
    let classifierRestartCount: Int
    let suppressedReason: AudioSuppressedReason?

    var payload: [String: Any] {
        var data: [String: Any] = [
            "running": running,
            "paused": paused,
            "capturing": capturing,
            "suppressed": suppressedReason != nil,
            "classificationRunning": classificationRunning,
            "engineRunning": engineRunning,
            "capturePipelineRunning": capturePipelineRunning,
            "engineState": engineState.rawValue,
            "classifierRestartCount": classifierRestartCount,
        ]
        if let lastClassificationAt {
            data["lastClassificationAt"] = Int(lastClassificationAt.timeIntervalSince1970 * 1_000)
        }
        if let lastAudioError {
            data["lastAudioError"] = lastAudioError
        }
        if let suppressedReason {
            data["suppressedReason"] = suppressedReason.rawValue
        }
        return data
    }
}

struct AudioCaptureMetadata {
    let wavId: String
    let burstId: String
    let captureSessionId: String
    let capturedAt: Date
    let durationMs: Int
    let byteSize: Int
    let url: URL

    var recentPayload: [String: Any] {
        [
            "wavId": wavId,
            "burstId": burstId,
            "captureSessionId": captureSessionId,
            "capturedAt": Self.iso8601.string(from: capturedAt),
            "durationMs": durationMs,
            "byteSize": byteSize,
        ]
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

struct TranscriptReadyRecord {
    let platform: String
    let wavId: String
    let burstId: String
    let captureSessionId: String
    let text: String
    let capturedAt: Date
    let durationMs: Int
    let provider: AudioTranscriptProvider
    let fallback: Bool
    let localProvider: AudioLocalSpeechProvider?
    let segmentIndex: Int?
    let triggerSource: String?
    let transcriptLocale: String?

    var payload: [String: Any] {
        var data: [String: Any] = [
            "platform": platform,
            "wavId": wavId,
            "burstId": burstId,
            "captureSessionId": captureSessionId,
            "text": text,
            "capturedAt": Self.iso8601.string(from: capturedAt),
            "durationMs": durationMs,
            "provider": provider.rawValue,
            "fallback": fallback,
        ]
        if let localProvider {
            data["localProvider"] = localProvider.rawValue
        }
        if let segmentIndex {
            data["segmentIndex"] = segmentIndex
        }
        if let triggerSource {
            data["triggerSource"] = triggerSource
        }
        if let transcriptLocale {
            data["transcriptLocale"] = transcriptLocale
        }
        return data
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

enum AudioCaptureFailure: LocalizedError {
    case engineStartFailed
    case captureUnavailable
    case wavNotFound
    case missingWavId

    var errorDescription: String? {
        switch self {
        case .engineStartFailed:
            return "Unable to start audio capture engine"
        case .captureUnavailable:
            return "Audio capture is not available"
        case .wavNotFound:
            return "Capture WAV not found"
        case .missingWavId:
            return "Missing wavId"
        }
    }
}
