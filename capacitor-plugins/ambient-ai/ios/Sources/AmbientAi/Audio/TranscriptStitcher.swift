import Foundation

struct TranscriptStitcher {
    static let maxChars = 6_000
    static let defaultGapResetInterval: TimeInterval = 8.0
    static let dedupInterval: TimeInterval = 90
    static let minOverlapLen = 8
    static let maxOverlapLen = 96

    var gapResetInterval: TimeInterval = defaultGapResetInterval

    private var buffer = ""
    private var lastRecognitionAt: Date?
    private var lastEmittedNormalised = ""
    private var lastEmittedAt: Date?

    var currentBuffer: String { buffer }

    mutating func reset() {
        buffer = ""
        lastRecognitionAt = nil
    }

    mutating func append(_ segment: String, at timestamp: Date) -> String {
        let trimmed = segment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return buffer }

        let normalised = Self.normalise(trimmed)
        if !normalised.isEmpty,
           let lastAt = lastEmittedAt,
           Date().timeIntervalSince(lastAt) < Self.dedupInterval,
           normalised == lastEmittedNormalised {
            return buffer
        }

        if let lastAt = lastRecognitionAt,
           timestamp.timeIntervalSince(lastAt) > gapResetInterval {
            buffer = ""
        }

        if buffer.isEmpty {
            buffer = trimmed
        } else {
            buffer = Self.mergeOverlapping(existing: buffer, incoming: trimmed)
        }

        if buffer.count > Self.maxChars {
            buffer = String(buffer.suffix(Self.maxChars))
        }

        lastRecognitionAt = timestamp
        lastEmittedNormalised = normalised
        lastEmittedAt = timestamp
        return buffer
    }

    static func mergeOverlapping(existing: String, incoming: String) -> String {
        let existingLower = existing.lowercased()
        let incomingLower = incoming.lowercased()

        let maxLen = min(maxOverlapLen, existing.count, incoming.count)
        guard maxLen >= minOverlapLen else {
            return existing + " " + incoming
        }

        for len in stride(from: maxLen, through: minOverlapLen, by: -1) {
            let suffixStart = existingLower.index(existingLower.endIndex, offsetBy: -len)
            let suffix = existingLower[suffixStart...]
            let prefixEnd = incomingLower.index(incomingLower.startIndex, offsetBy: len)
            let prefix = incomingLower[..<prefixEnd]

            if suffix == prefix {
                return existing + incoming.dropFirst(len)
            }
        }

        return existing + " " + incoming
    }

    static func normalise(_ text: String) -> String {
        text.lowercased()
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}
