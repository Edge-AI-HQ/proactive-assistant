import Foundation

actor CloudTranscriptionWorker {
    private static let maxTranscriptChars = 6_000

    func refine(wavURL: URL, config: AudioCaptureConfig) async -> String? {
        guard config.canRefineDirectly,
              let apiKey = config.cloudApiKey,
              !apiKey.isEmpty else {
            return nil
        }

        do {
            return try await withThrowingTaskGroup(of: String?.self) { group in
                group.addTask {
                    try await Self.transcribe(wavURL: wavURL, apiKey: apiKey, config: config)
                }
                group.addTask {
                    try await Task.sleep(nanoseconds: UInt64(config.cloudRefineTimeoutMs) * 1_000_000)
                    return nil
                }

                let first = try await group.next() ?? nil
                group.cancelAll()
                return first
            }
        } catch {
            return nil
        }
    }

    private static func transcribe(
        wavURL: URL,
        apiKey: String,
        config: AudioCaptureConfig
    ) async throws -> String? {
        let audioData = try Data(contentsOf: wavURL)
        let boundary = "Boundary-\(UUID().uuidString)"
        var body = Data()

        body.appendFormBoundary(boundary)
        body.appendString("Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n")
        body.appendString("Content-Type: audio/wav\r\n\r\n")
        body.append(audioData)
        body.appendString("\r\n")

        body.appendFormBoundary(boundary)
        body.appendString("Content-Disposition: form-data; name=\"model\"\r\n\r\n")
        body.appendString("\(config.modelName)\r\n")

        body.appendFormBoundary(boundary)
        body.appendString("Content-Disposition: form-data; name=\"response_format\"\r\n\r\n")
        body.appendString("json\r\n")
        body.appendString("--\(boundary)--\r\n")

        var request = URLRequest(url: transcriptionEndpoint(baseURL: config.resolvedCloudBaseURL))
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.timeoutInterval = TimeInterval(config.cloudRefineTimeoutMs) / 1_000.0

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = request.timeoutInterval
        configuration.timeoutIntervalForResource = request.timeoutInterval
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else {
            return nil
        }

        struct TranscriptionResponse: Decodable {
            let text: String?
        }

        let decoded = try JSONDecoder().decode(TranscriptionResponse.self, from: data)
        let text = decoded.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else { return nil }
        return String(text.prefix(Self.maxTranscriptChars))
    }

    private static func transcriptionEndpoint(baseURL: URL) -> URL {
        let path = baseURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if path.hasSuffix("audio/transcriptions") {
            return baseURL
        }
        if path.hasSuffix("v1") {
            return baseURL.appendingPathComponent("audio/transcriptions")
        }
        return baseURL
            .appendingPathComponent("v1")
            .appendingPathComponent("audio/transcriptions")
    }
}

private extension Data {
    mutating func appendFormBoundary(_ boundary: String) {
        appendString("--\(boundary)\r\n")
    }

    mutating func appendString(_ string: String) {
        if let data = string.data(using: .utf8) {
            append(data)
        }
    }
}
