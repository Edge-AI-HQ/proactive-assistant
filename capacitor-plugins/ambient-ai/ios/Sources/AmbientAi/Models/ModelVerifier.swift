import Foundation


struct ModelVerifyOutcome: Sendable {
    let ok: Bool
    let elapsedMs: Int
    let output: String?
    let errorMessage: String?
}

protocol ModelVerifyEngine: Sendable {
    func verify(profile: ModelProfile, path: URL) async -> ModelVerifyOutcome
}

struct DispatchingVerifyEngine: ModelVerifyEngine {
    let header: ModelVerifyEngine
    let llama: ModelVerifyEngine

    func verify(profile: ModelProfile, path: URL) async -> ModelVerifyOutcome {
        switch profile.kind {
        case .asr:
            return await header.verify(profile: profile, path: path)
        case .llm:
            return await llama.verify(profile: profile, path: path)
        }
    }
}

/// Reads the first N bytes and compares against the profile's magic.
/// Used for ASR until whisper.cpp on-device verify is wired up.
struct HeaderOnlyVerifyEngine: ModelVerifyEngine {
    func verify(profile: ModelProfile, path: URL) async -> ModelVerifyOutcome {
        let start = Date()
        let fm = FileManager.default
        guard fm.fileExists(atPath: path.path) else {
            return ModelVerifyOutcome(
                ok: false,
                elapsedMs: Int(Date().timeIntervalSince(start) * 1000),
                output: nil,
                errorMessage: "Model file not found"
            )
        }
        guard let handle = try? FileHandle(forReadingFrom: path) else {
            return ModelVerifyOutcome(
                ok: false,
                elapsedMs: Int(Date().timeIntervalSince(start) * 1000),
                output: nil,
                errorMessage: "Cannot open model file"
            )
        }
        defer { try? handle.close() }
        guard let header = try? handle.read(upToCount: profile.magic.headerBytes.count) else {
            return ModelVerifyOutcome(
                ok: false,
                elapsedMs: Int(Date().timeIntervalSince(start) * 1000),
                output: nil,
                errorMessage: "Cannot read model header"
            )
        }
        let matches = Array(header) == profile.magic.headerBytes
        let label = "Magic '\(profile.magic.rawValue)' matched (real ASR inference pending whisper.cpp integration)"
        return ModelVerifyOutcome(
            ok: matches,
            elapsedMs: Int(Date().timeIntervalSince(start) * 1000),
            output: matches ? label : nil,
            errorMessage: matches ? nil : "Header magic mismatch (expected \(profile.magic.rawValue))"
        )
    }
}

/// Verifies a GGUF model by running a short prompt through the shared llama runner.
struct LlamaVerifyEngine: ModelVerifyEngine {
    let prompt: String
    let maxTokens: Int
    let timeout: TimeInterval
    let generator: LlamaTextGenerating

    init(prompt: String = "Say hi in one word",
         maxTokens: Int = 16,
         timeout: TimeInterval = 60,
         generator: LlamaTextGenerating = LlamaTextGenerationEngine()) {
        self.prompt = prompt
        self.maxTokens = maxTokens
        self.timeout = timeout
        self.generator = generator
    }

    func verify(profile: ModelProfile, path: URL) async -> ModelVerifyOutcome {
        let start = Date()
        do {
            let text = try await generator.generate(
                modelURL: path,
                options: LlamaTextGenerationOptions(
                    prompt: prompt,
                    maxTokens: maxTokens,
                    timeout: timeout
                )
            )
            let elapsed = Int(Date().timeIntervalSince(start) * 1000)
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let succeeded = !trimmed.isEmpty
            return ModelVerifyOutcome(
                ok: succeeded,
                elapsedMs: elapsed,
                output: succeeded ? "\(profile.displayName) replied: \"\(trimmed)\"" : nil,
                errorMessage: succeeded ? nil : "Model returned an empty response."
            )
        } catch {
            return ModelVerifyOutcome(
                ok: false,
                elapsedMs: Int(Date().timeIntervalSince(start) * 1000),
                output: nil,
                errorMessage: error.localizedDescription
            )
        }
    }
}
