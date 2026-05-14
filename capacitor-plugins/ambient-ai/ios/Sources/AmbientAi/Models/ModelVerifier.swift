import Foundation

#if canImport(LlamaSwift)
import LlamaSwift
#endif

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

/// Loads a GGUF model via llama.cpp (mattt/llama.swift), tokenizes a
/// minimal prompt, runs greedy decode for a few tokens, and returns
/// the generated text. Bounded by a deadline so the UI doesn't hang.
struct LlamaVerifyEngine: ModelVerifyEngine {
    let prompt: String
    let maxTokens: Int
    let timeout: TimeInterval

    init(prompt: String = "Say hi in one word",
         maxTokens: Int = 16,
         timeout: TimeInterval = 60) {
        self.prompt = prompt
        self.maxTokens = maxTokens
        self.timeout = timeout
    }

    func verify(profile: ModelProfile, path: URL) async -> ModelVerifyOutcome {
        let start = Date()
        #if canImport(LlamaSwift)
        do {
            let text = try await runReal(modelURL: path,
                                         deadline: start.addingTimeInterval(timeout))
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
        #else
        return ModelVerifyOutcome(
            ok: false,
            elapsedMs: Int(Date().timeIntervalSince(start) * 1000),
            output: nil,
            errorMessage: "llama.cpp Swift package not linked into this build."
        )
        #endif
    }

    #if canImport(LlamaSwift)
    private static let backendInitOnce: Void = {
        llama_backend_init()
    }()

    private func runReal(modelURL: URL, deadline: Date) async throws -> String {
        _ = Self.backendInitOnce

        var modelParams = llama_model_default_params()
        #if targetEnvironment(simulator)
        modelParams.n_gpu_layers = 0
        #else
        modelParams.n_gpu_layers = 99
        #endif

        guard let model = llama_model_load_from_file(modelURL.path, modelParams) else {
            throw NSError(domain: "LlamaVerify", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "llama_model_load_from_file returned nil — file may be corrupted or use an unsupported quant.",
            ])
        }
        defer { llama_model_free(model) }

        var ctxParams = llama_context_default_params()
        ctxParams.n_ctx = 2048
        ctxParams.n_batch = 512
        ctxParams.n_threads = 4
        ctxParams.n_threads_batch = 4
        guard let ctx = llama_init_from_model(model, ctxParams) else {
            throw NSError(domain: "LlamaVerify", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "llama_init_from_model returned nil — context allocation failed.",
            ])
        }
        defer { llama_free(ctx) }

        let vocab = llama_model_get_vocab(model)
        let utf8Count = prompt.utf8.count
        let maxTokenCount = utf8Count + 8
        var promptTokens = [llama_token](repeating: 0, count: maxTokenCount)
        let nTokens = llama_tokenize(
            vocab,
            prompt,
            Int32(utf8Count),
            &promptTokens,
            Int32(maxTokenCount),
            true,
            true
        )
        guard nTokens > 0 else {
            throw NSError(domain: "LlamaVerify", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "llama_tokenize returned \(nTokens).",
            ])
        }
        promptTokens = Array(promptTokens.prefix(Int(nTokens)))

        var batch = llama_batch_init(512, 0, 1)
        defer { llama_batch_free(batch) }

        let chunkLen = promptTokens.count
        batch.n_tokens = Int32(chunkLen)
        for i in 0..<chunkLen {
            batch.token[i] = promptTokens[i]
            batch.pos[i] = Int32(i)
            batch.n_seq_id[i] = 1
            if let seqIds = batch.seq_id, let seqId = seqIds[i] {
                seqId[0] = 0
            }
            batch.logits[i] = 0
        }
        if batch.n_tokens > 0 {
            batch.logits[Int(batch.n_tokens) - 1] = 1
        }
        guard llama_decode(ctx, batch) == 0 else {
            throw NSError(domain: "LlamaVerify", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "llama_decode failed on prompt.",
            ])
        }

        var generated: [llama_token] = []
        var nCur = Int32(promptTokens.count)
        let vocabSize = llama_vocab_n_tokens(vocab)
        let eos = llama_vocab_eos(vocab)

        for _ in 0..<maxTokens {
            if Date() > deadline { break }
            try Task.checkCancellation()
            guard let logits = llama_get_logits_ith(ctx, batch.n_tokens - 1) else {
                throw NSError(domain: "LlamaVerify", code: 5, userInfo: [
                    NSLocalizedDescriptionKey: "llama_get_logits_ith returned nil.",
                ])
            }
            var maxLogit = logits[0]
            var nextToken: llama_token = 0
            for v in 1..<Int(vocabSize) {
                if logits[v] > maxLogit {
                    maxLogit = logits[v]
                    nextToken = llama_token(v)
                }
            }
            if nextToken == eos { break }
            generated.append(nextToken)
            batch.n_tokens = 1
            batch.token[0] = nextToken
            batch.pos[0] = nCur
            batch.n_seq_id[0] = 1
            if let seqIds = batch.seq_id, let seqId = seqIds[0] {
                seqId[0] = 0
            }
            batch.logits[0] = 1
            nCur += 1
            guard llama_decode(ctx, batch) == 0 else {
                throw NSError(domain: "LlamaVerify", code: 6, userInfo: [
                    NSLocalizedDescriptionKey: "llama_decode failed at generated token \(generated.count).",
                ])
            }
            if generated.count % 4 == 0 {
                await Task.yield()
            }
        }

        var output = ""
        var buffer = [CChar](repeating: 0, count: 256)
        for token in generated {
            for i in buffer.indices { buffer[i] = 0 }
            let n = llama_token_to_piece(
                vocab,
                token,
                &buffer,
                Int32(buffer.count),
                0,
                false
            )
            if n > 0 {
                let bytes = buffer.prefix(Int(n)).map { UInt8(bitPattern: $0) }
                if let piece = String(bytes: bytes, encoding: .utf8) {
                    output += piece
                }
            }
        }
        return output
    }
    #endif
}
