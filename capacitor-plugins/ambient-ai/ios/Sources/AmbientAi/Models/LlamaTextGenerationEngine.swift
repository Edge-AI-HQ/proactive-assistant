import Foundation

#if canImport(LlamaSwift)
import LlamaSwift
#endif

struct LlamaTextGenerationOptions: Sendable {
    let prompt: String
    let maxTokens: Int
    let timeout: TimeInterval
}

protocol LlamaTextGenerating: Sendable {
    func generate(modelURL: URL, options: LlamaTextGenerationOptions) async throws -> String
}

enum LlamaTextGenerationError: LocalizedError {
    case unavailable
    case modelLoadFailed
    case contextInitFailed
    case tokenizeFailed(Int32)
    case promptDecodeFailed
    case logitsUnavailable
    case decodeFailed(Int)
    case timeout

    var errorDescription: String? {
        switch self {
        case .unavailable:
            return "llama.cpp Swift package not linked into this build."
        case .modelLoadFailed:
            return "llama_model_load_from_file returned nil."
        case .contextInitFailed:
            return "llama_init_from_model returned nil."
        case .tokenizeFailed(let code):
            return "llama_tokenize returned \(code)."
        case .promptDecodeFailed:
            return "llama_decode failed on prompt."
        case .logitsUnavailable:
            return "llama_get_logits_ith returned nil."
        case .decodeFailed(let count):
            return "llama_decode failed at generated token \(count)."
        case .timeout:
            return "generation timed out."
        }
    }
}

struct LlamaTextGenerationEngine: LlamaTextGenerating {
    func generate(modelURL: URL, options: LlamaTextGenerationOptions) async throws -> String {
        #if canImport(LlamaSwift)
        return try await runReal(
            modelURL: modelURL,
            prompt: options.prompt,
            maxTokens: options.maxTokens,
            deadline: Date().addingTimeInterval(options.timeout)
        )
        #else
        throw LlamaTextGenerationError.unavailable
        #endif
    }

    #if canImport(LlamaSwift)
    private static let backendInitOnce: Void = {
        llama_backend_init()
    }()

    private func runReal(
        modelURL: URL,
        prompt: String,
        maxTokens: Int,
        deadline: Date
    ) async throws -> String {
        _ = Self.backendInitOnce

        var modelParams = llama_model_default_params()
        #if targetEnvironment(simulator)
        modelParams.n_gpu_layers = 0
        #else
        modelParams.n_gpu_layers = 99
        #endif

        guard let model = llama_model_load_from_file(modelURL.path, modelParams) else {
            throw LlamaTextGenerationError.modelLoadFailed
        }
        defer { llama_model_free(model) }

        var ctxParams = llama_context_default_params()
        ctxParams.n_ctx = 2048
        ctxParams.n_batch = 512
        ctxParams.n_threads = 4
        ctxParams.n_threads_batch = 4
        guard let ctx = llama_init_from_model(model, ctxParams) else {
            throw LlamaTextGenerationError.contextInitFailed
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
            throw LlamaTextGenerationError.tokenizeFailed(nTokens)
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
            throw LlamaTextGenerationError.promptDecodeFailed
        }

        var generated: [llama_token] = []
        var nCur = Int32(promptTokens.count)
        let vocabSize = llama_vocab_n_tokens(vocab)
        let eos = llama_vocab_eos(vocab)

        for _ in 0..<maxTokens {
            if Date() > deadline { throw LlamaTextGenerationError.timeout }
            try Task.checkCancellation()
            guard let logits = llama_get_logits_ith(ctx, batch.n_tokens - 1) else {
                throw LlamaTextGenerationError.logitsUnavailable
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
                throw LlamaTextGenerationError.decodeFailed(generated.count)
            }
            if generated.count % 4 == 0 {
                await Task.yield()
            }
        }

        var output = ""
        var buffer = [CChar](repeating: 0, count: 256)
        for token in generated {
            for i in buffer.indices { buffer[i] = 0 }
            let n = llama_token_to_piece(vocab, token, &buffer, Int32(buffer.count), 0, false)
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
