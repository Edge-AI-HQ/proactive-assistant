import Foundation

enum ModelKind: String, Codable, Sendable {
    case asr
    case llm
}

enum ModelMagic: String, Codable, Sendable {
    case gguf = "GGUF"
    case ggml = "ggml"

    var headerBytes: [UInt8] {
        switch self {
        case .gguf: return [0x47, 0x47, 0x55, 0x46]
        case .ggml: return [0x6c, 0x6d, 0x67, 0x67]
        }
    }
}

enum ModelMirror: String, Codable, Sendable {
    case hf = "hf"
    case hfMirror = "hf-mirror"

    var host: String {
        switch self {
        case .hf: return "huggingface.co"
        case .hfMirror: return "hf-mirror.com"
        }
    }
}

struct ModelProfile: Sendable, Equatable {
    let id: String
    let kind: ModelKind
    let displayName: String
    let repo: String
    let file: String
    let approxBytes: Int64
    let magic: ModelMagic
    let notes: String?

    var fileExtension: String {
        (file as NSString).pathExtension
    }

    func resolvedURL(mirror: ModelMirror) -> URL? {
        let encodedRepo = repo
            .split(separator: "/")
            .map { String($0).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "" }
            .joined(separator: "/")
        let encodedFile = file.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? file
        return URL(string: "https://\(mirror.host)/\(encodedRepo)/resolve/main/\(encodedFile)")
    }

    func jsObject() -> [String: Any] {
        var dict: [String: Any] = [
            "id": id,
            "kind": kind.rawValue,
            "displayName": displayName,
            "repo": repo,
            "file": file,
            "approxBytes": approxBytes,
            "magic": magic.rawValue,
        ]
        if let notes { dict["notes"] = notes }
        return dict
    }
}

enum ModelManifest {
    static let profiles: [ModelProfile] = [
        // ASR — whisper.cpp ggml binaries
        ModelProfile(
            id: "whisper-tiny-q5_1",
            kind: .asr,
            displayName: "Whisper tiny (Q5_1)",
            repo: "ggerganov/whisper.cpp",
            file: "ggml-tiny-q5_1.bin",
            approxBytes: 32_200_000,
            magic: .ggml,
            notes: "Multilingual, smallest variant; OK for offline gist transcription."
        ),
        ModelProfile(
            id: "whisper-tiny",
            kind: .asr,
            displayName: "Whisper tiny",
            repo: "ggerganov/whisper.cpp",
            file: "ggml-tiny.bin",
            approxBytes: 75_500_000,
            magic: .ggml,
            notes: "Multilingual baseline; good entry point."
        ),
        ModelProfile(
            id: "whisper-base",
            kind: .asr,
            displayName: "Whisper base",
            repo: "ggerganov/whisper.cpp",
            file: "ggml-base.bin",
            approxBytes: 142_100_000,
            magic: .ggml,
            notes: "Recommended default for short ambient bursts."
        ),
        ModelProfile(
            id: "whisper-small-q5_1",
            kind: .asr,
            displayName: "Whisper small (Q5_1)",
            repo: "ggerganov/whisper.cpp",
            file: "ggml-small-q5_1.bin",
            approxBytes: 188_800_000,
            magic: .ggml,
            notes: "Quantized small; balances accuracy and size."
        ),

        // LLM — GGUF for llama.cpp
        ModelProfile(
            id: "smollm2-360m-q4",
            kind: .llm,
            displayName: "SmolLM2 360M (Q4_K_M)",
            repo: "HuggingFaceTB/SmolLM2-360M-Instruct-GGUF",
            file: "smollm2-360m-instruct-q4_k_m.gguf",
            approxBytes: 280_000_000,
            magic: .gguf,
            notes: "Tiniest usable instruct model; runs comfortably on iPhone."
        ),
        ModelProfile(
            id: "qwen3-0_6b-q8",
            kind: .llm,
            displayName: "Qwen3 0.6B (Q8_0)",
            repo: "Qwen/Qwen3-0.6B-GGUF",
            file: "Qwen3-0.6B-Q8_0.gguf",
            approxBytes: 640_000_000,
            magic: .gguf,
            notes: "Official Qwen3 0.6B, only Q8_0 shipped upstream."
        ),
        ModelProfile(
            id: "qwen3-1_7b-q4",
            kind: .llm,
            displayName: "Qwen3 1.7B (Q4_K_M)",
            repo: "Qwen/Qwen3-1.7B-GGUF",
            file: "Qwen3-1.7B-Q4_K_M.gguf",
            approxBytes: 1_100_000_000,
            magic: .gguf,
            notes: "Strong tradeoff; recommended LLM default for ambient summarization."
        ),
        ModelProfile(
            id: "llama-3_2-1b-q4",
            kind: .llm,
            displayName: "Llama 3.2 1B Instruct (Q4_K_M)",
            repo: "bartowski/Llama-3.2-1B-Instruct-GGUF",
            file: "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
            approxBytes: 770_000_000,
            magic: .gguf,
            notes: "Community quant by bartowski."
        ),
        ModelProfile(
            id: "gemma-3-1b-q4",
            kind: .llm,
            displayName: "Gemma 3 1B IT (Q4_K_M)",
            repo: "unsloth/gemma-3-1b-it-GGUF",
            file: "gemma-3-1b-it-Q4_K_M.gguf",
            approxBytes: 720_000_000,
            magic: .gguf,
            notes: "Unsloth dynamic quant; chat-tuned."
        ),
    ]

    static func profile(forId id: String) -> ModelProfile? {
        profiles.first { $0.id == id }
    }
}
