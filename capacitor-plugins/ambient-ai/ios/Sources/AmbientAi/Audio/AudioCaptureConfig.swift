import Foundation

enum AudioCloudMode: String {
    case off
    case devDirect
    case proxy
}

struct AudioCaptureConfig {
    static let defaultModelName = "gpt-4o-transcribe"
    static let defaultCloudRefineTimeoutMs = 20_000
    static let defaultPreRollMs = 2_000
    static let defaultPostRollMs = 10_000
    static let defaultMaxBurstMs = 30_000
    static let defaultMinBurstMs = 800
    static let defaultSessionSilenceGapMs = 30_000
    static let defaultMaxSessionDurationMs = 5 * 60 * 1_000
    static let defaultWavRetentionTtlMs = 7 * 24 * 60 * 60 * 1_000
    static let defaultWavMaxBytes = 3 * 1024 * 1024 * 1024
    static let defaultWavMaxFiles = 10_000

    let cloudMode: AudioCloudMode
    let recognitionLocale: String?
    let cloudApiKey: String?
    let cloudBaseURL: URL?
    let modelName: String
    let cloudRefineTimeoutMs: Int
    let preRollMs: Int
    let postRollMs: Int
    let maxBurstMs: Int
    let minBurstMs: Int
    let sessionSilenceGapMs: Int
    let maxSessionDurationMs: Int
    let wavRetentionTtlMs: Int
    let wavMaxBytes: Int
    let wavMaxFiles: Int

    static let `default` = AudioCaptureConfig()

    init(
        cloudMode: AudioCloudMode = .off,
        recognitionLocale: String? = nil,
        cloudApiKey: String? = nil,
        cloudBaseURL: URL? = nil,
        modelName: String = AudioCaptureConfig.defaultModelName,
        cloudRefineTimeoutMs: Int = AudioCaptureConfig.defaultCloudRefineTimeoutMs,
        preRollMs: Int = AudioCaptureConfig.defaultPreRollMs,
        postRollMs: Int = AudioCaptureConfig.defaultPostRollMs,
        maxBurstMs: Int = AudioCaptureConfig.defaultMaxBurstMs,
        minBurstMs: Int = AudioCaptureConfig.defaultMinBurstMs,
        sessionSilenceGapMs: Int = AudioCaptureConfig.defaultSessionSilenceGapMs,
        maxSessionDurationMs: Int = AudioCaptureConfig.defaultMaxSessionDurationMs,
        wavRetentionTtlMs: Int = AudioCaptureConfig.defaultWavRetentionTtlMs,
        wavMaxBytes: Int = AudioCaptureConfig.defaultWavMaxBytes,
        wavMaxFiles: Int = AudioCaptureConfig.defaultWavMaxFiles
    ) {
        let trimmedModel = modelName.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedLocale = recognitionLocale?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedKey = cloudApiKey?.trimmingCharacters(in: .whitespacesAndNewlines)

        self.cloudMode = cloudMode
        self.recognitionLocale = trimmedLocale?.isEmpty == true ? nil : trimmedLocale
        self.cloudApiKey = trimmedKey?.isEmpty == true ? nil : trimmedKey
        self.cloudBaseURL = cloudBaseURL
        self.modelName = trimmedModel.isEmpty ? Self.defaultModelName : trimmedModel
        self.cloudRefineTimeoutMs = Self.positive(
            cloudRefineTimeoutMs,
            fallback: Self.defaultCloudRefineTimeoutMs,
            minimum: 1_000,
            maximum: 120_000
        )
        self.preRollMs = Self.positive(
            preRollMs,
            fallback: Self.defaultPreRollMs,
            minimum: 0,
            maximum: 5_000
        )
        self.postRollMs = Self.positive(
            postRollMs,
            fallback: Self.defaultPostRollMs,
            minimum: 100,
            maximum: 20_000
        )
        let resolvedMinBurstMs = Self.positive(
            minBurstMs,
            fallback: Self.defaultMinBurstMs,
            minimum: 200,
            maximum: 30_000
        )
        self.minBurstMs = resolvedMinBurstMs
        self.maxBurstMs = max(
            resolvedMinBurstMs,
            Self.positive(
                maxBurstMs,
                fallback: Self.defaultMaxBurstMs,
                minimum: resolvedMinBurstMs,
                maximum: 300_000
            )
        )
        self.sessionSilenceGapMs = Self.positive(
            sessionSilenceGapMs,
            fallback: Self.defaultSessionSilenceGapMs,
            minimum: self.postRollMs,
            maximum: 10 * 60 * 1_000
        )
        self.maxSessionDurationMs = Self.positive(
            maxSessionDurationMs,
            fallback: Self.defaultMaxSessionDurationMs,
            minimum: 60_000,
            maximum: 60 * 60 * 1_000
        )
        self.wavRetentionTtlMs = Self.positive(
            wavRetentionTtlMs,
            fallback: Self.defaultWavRetentionTtlMs,
            minimum: 60_000,
            maximum: 7 * 24 * 60 * 60 * 1_000
        )
        self.wavMaxBytes = Self.positive(
            wavMaxBytes,
            fallback: Self.defaultWavMaxBytes,
            minimum: 256 * 1024,
            maximum: Self.defaultWavMaxBytes
        )
        self.wavMaxFiles = Self.positive(
            wavMaxFiles,
            fallback: Self.defaultWavMaxFiles,
            minimum: 1,
            maximum: Self.defaultWavMaxFiles
        )
    }

    var canRefineDirectly: Bool {
        cloudMode == .devDirect && cloudApiKey != nil
    }

    var resolvedCloudBaseURL: URL {
        cloudBaseURL ?? URL(string: "https://api.openai.com")!
    }

    private static func positive(
        _ value: Int,
        fallback: Int,
        minimum: Int,
        maximum: Int
    ) -> Int {
        guard value >= minimum else { return fallback }
        return min(value, maximum)
    }
}
