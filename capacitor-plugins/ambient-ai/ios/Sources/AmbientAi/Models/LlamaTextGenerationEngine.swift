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
    case batchSequenceUnavailable
    case batchCapacityExceeded
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
        case .batchSequenceUnavailable:
            return "llama_batch seq_id storage is unavailable."
        case .batchCapacityExceeded:
            return "llama_batch capacity was exceeded."
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

    private func clearBatch(_ batch: inout llama_batch) {
        batch.n_tokens = 0
    }

    private func addBatchToken(
        _ batch: inout llama_batch,
        token: llama_token,
        position: llama_pos,
        seqIds: [llama_seq_id],
        logits: Bool
    ) throws {
        let index = Int(batch.n_tokens)
        guard index < 512 else {
            throw LlamaTextGenerationError.batchCapacityExceeded
        }
        batch.token[index] = token
        batch.pos[index] = position
        batch.n_seq_id[index] = Int32(seqIds.count)
        guard let seqIdsStorage = batch.seq_id, let seqIdStorage = seqIdsStorage[index] else {
            throw LlamaTextGenerationError.batchSequenceUnavailable
        }
        for (seqIndex, seqId) in seqIds.enumerated() {
            seqIdStorage[seqIndex] = seqId
        }
        batch.logits[index] = logits ? 1 : 0
        batch.n_tokens += 1
    }

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

        let batchCapacity = 512
        var promptOffset = 0
        while promptOffset < promptTokens.count {
            clearBatch(&batch)
            let chunkEnd = min(promptOffset + batchCapacity, promptTokens.count)
            for index in promptOffset..<chunkEnd {
                try addBatchToken(
                    &batch,
                    token: promptTokens[index],
                    position: llama_pos(index),
                    seqIds: [0],
                    logits: index == promptTokens.count - 1
                )
            }
            guard llama_decode(ctx, batch) == 0 else {
                throw LlamaTextGenerationError.promptDecodeFailed
            }
            promptOffset = chunkEnd
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
            clearBatch(&batch)
            try addBatchToken(
                &batch,
                token: nextToken,
                position: nCur,
                seqIds: [0],
                logits: true
            )
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
