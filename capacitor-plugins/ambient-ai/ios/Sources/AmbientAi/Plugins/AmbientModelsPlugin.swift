@preconcurrency import Capacitor
import Foundation

@objc(AmbientModelsPlugin)
public class AmbientModelsPlugin: CAPPlugin, CAPBridgedPlugin {
    private static let timelineBatchMaxTokens = 512
    private static let timelineSingleMaxTokens = 512
    private static let timelineGenerationTimeout: TimeInterval = 180

    public let identifier = "AmbientModelsPlugin"
    public let jsName = "AmbientModels"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "listModels", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startModelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelModelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "verifyModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generateTimelineEvent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generateTimelineBatchDecision", returnType: CAPPluginReturnPromise),
    ]

    private let store = ModelStore()
    private lazy var downloader = ModelDownloader(store: store)
    private let verifyEngine: ModelVerifyEngine = makeVerifyEngine()
    private let textGenerator: LlamaTextGenerating = LlamaTextGenerationEngine()
    private var callbacksWired = false

    public override func load() {
        wireCallbacksIfNeeded()
    }

    private func wireCallbacksIfNeeded() {
        if callbacksWired { return }
        callbacksWired = true
        let weakSelf = WeakRef(self)
        Task { [downloader] in
            await downloader.setCallbacks(
                progress: { snap in
                    weakSelf.value?.emit(snap, event: "modelDownloadProgress")
                },
                done: { snap in
                    weakSelf.value?.emit(snap, event: "modelDownloadDone")
                }
            )
        }
    }

    @objc func listModels(_ call: CAPPluginCall) {
        wireCallbacksIfNeeded()
        let profiles = ModelManifest.profiles
        Task { [downloader] in
            var statuses: [[String: Any]] = []
            for profile in profiles {
                let snap = await downloader.status(for: profile)
                statuses.append(snap.jsObject())
            }
            DispatchQueue.main.async {
                call.resolve([
                    "profiles": profiles.map { $0.jsObject() },
                    "statuses": statuses,
                ])
            }
        }
    }

    @objc func startModelDownload(_ call: CAPPluginCall) {
        wireCallbacksIfNeeded()
        guard let id = call.getString("id"),
              let profile = ModelManifest.profile(forId: id) else {
            call.reject("Unknown model id", "MODEL_NOT_FOUND")
            return
        }
        let mirror = ModelMirror(rawValue: call.getString("preferredMirror") ?? "") ?? .hfMirror
        Task { [downloader] in
            await downloader.start(profile: profile, preferredMirror: mirror)
            DispatchQueue.main.async { call.resolve() }
        }
    }

    @objc func cancelModelDownload(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("Missing id", "MISSING_ID")
            return
        }
        Task { [downloader] in
            await downloader.cancel(id: id)
            DispatchQueue.main.async { call.resolve() }
        }
    }

    @objc func deleteModel(_ call: CAPPluginCall) {
        guard let id = call.getString("id"),
              let profile = ModelManifest.profile(forId: id) else {
            call.reject("Unknown model id", "MODEL_NOT_FOUND")
            return
        }
        Task { [downloader, store] in
            _ = await store.remove(profile)
            await downloader.clearVerifyState(profileId: id, presentAfter: false)
            let snap = await downloader.status(for: profile)
            DispatchQueue.main.async {
                self.notifyListeners("modelDownloadDone", data: snap.jsObject())
                call.resolve()
            }
        }
    }

    @objc func verifyModel(_ call: CAPPluginCall) {
        guard let id = call.getString("id"),
              let profile = ModelManifest.profile(forId: id) else {
            call.reject("Unknown model id", "MODEL_NOT_FOUND")
            return
        }
        Task { [downloader, store, verifyEngine] in
            let present = await store.isPresent(profile)
            if !present {
                let payload: [String: Any] = [
                    "id": id,
                    "ok": false,
                    "elapsedMs": 0,
                    "errorMessage": "Model not downloaded",
                ]
                DispatchQueue.main.async { call.resolve(payload) }
                return
            }
            await downloader.markVerifying(profileId: id)
            let path = await store.fileURL(for: profile)
            let outcome = await verifyEngine.verify(profile: profile, path: path)
            await downloader.recordVerifyResult(
                profileId: id,
                ok: outcome.ok,
                output: outcome.output,
                error: outcome.errorMessage
            )
            let snap = await downloader.status(for: profile)
            DispatchQueue.main.async {
                self.notifyListeners("modelDownloadProgress", data: snap.jsObject())
                var result: [String: Any] = [
                    "id": id,
                    "ok": outcome.ok,
                    "elapsedMs": outcome.elapsedMs,
                ]
                if let output = outcome.output { result["output"] = output }
                if let err = outcome.errorMessage { result["errorMessage"] = err }
                call.resolve(result)
            }
        }
    }


    @objc func generateTimelineBatchDecision(_ call: CAPPluginCall) {
        guard let id = call.getString("modelId") else {
            call.reject("Missing modelId", "model_not_found")
            return
        }
        guard let profile = ModelManifest.profile(forId: id) else {
            call.reject("Unknown model id", "model_not_found")
            return
        }
        guard profile.kind == .llm else {
            call.reject("Selected model is not an LLM", "model_not_llm")
            return
        }
        let batch = call.getObject("batch") ?? [:]
        Task { [downloader, store, textGenerator] in
            let present = await store.isPresent(profile)
            guard present else {
                DispatchQueue.main.async { call.reject("Model not downloaded", "model_not_present") }
                return
            }
            let status = await downloader.status(for: profile)
            guard status.lastVerifyResult == "ok" else {
                DispatchQueue.main.async { call.reject("Model must be verified before timeline generation", "verify_required") }
                return
            }
            let path = await store.fileURL(for: profile)
            do {
                let plan = Self.timelineBatchMessages(batch: batch)
                let text = try await textGenerator.generate(
                    modelURL: path,
                    messagesOptions: LlamaTextGenerationMessagesOptions(
                        messages: plan.messages,
                        assistantPrefill: plan.prefill,
                        maxTokens: Self.timelineBatchMaxTokens,
                        timeout: Self.timelineGenerationTimeout
                    )
                )
                let combined = plan.prefill + text
                Self.logModelOutput(stage: "batch", prefill: plan.prefill, text: text)
                let object: [String: Any]
                do {
                    object = try Self.timelineDraftObject(from: combined)
                } catch {
                    Self.logModelOutput(stage: "batch.parse_failure", prefill: plan.prefill, text: text)
                    throw error
                }
                guard object["decisions"] is [[String: Any]] else {
                    Self.logModelOutput(stage: "batch.shape_failure", prefill: plan.prefill, text: text)
                    throw TimelineGenerationParseError.invalidJSON
                }
                DispatchQueue.main.async { call.resolve(object) }
            } catch LlamaTextGenerationError.timeout {
                DispatchQueue.main.async { call.reject("Timeline generation timed out", "generation_timeout") }
            } catch LlamaTextGenerationError.chatTemplateUnavailable {
                DispatchQueue.main.async { call.reject("Model has no embedded chat template", "chat_template_unavailable") }
            } catch let error as TimelineGenerationParseError {
                DispatchQueue.main.async { call.reject(error.localizedDescription, "invalid_json") }
            } catch {
                DispatchQueue.main.async { call.reject(error.localizedDescription, "generation_failed") }
            }
        }
    }

    @objc func generateTimelineEvent(_ call: CAPPluginCall) {
        guard let id = call.getString("modelId") else {
            call.reject("Missing modelId", "model_not_found")
            return
        }
        guard let profile = ModelManifest.profile(forId: id) else {
            call.reject("Unknown model id", "model_not_found")
            return
        }
        guard profile.kind == .llm else {
            call.reject("Selected model is not an LLM", "model_not_llm")
            return
        }
        let window = call.getObject("window") ?? [:]
        Task { [downloader, store, textGenerator] in
            let present = await store.isPresent(profile)
            guard present else {
                DispatchQueue.main.async { call.reject("Model not downloaded", "model_not_present") }
                return
            }
            let status = await downloader.status(for: profile)
            guard status.lastVerifyResult == "ok" else {
                DispatchQueue.main.async { call.reject("Model must be verified before timeline generation", "verify_required") }
                return
            }
            let path = await store.fileURL(for: profile)
            do {
                let plan = Self.timelineSingleMessages(window: window)
                let text = try await textGenerator.generate(
                    modelURL: path,
                    messagesOptions: LlamaTextGenerationMessagesOptions(
                        messages: plan.messages,
                        assistantPrefill: plan.prefill,
                        maxTokens: Self.timelineSingleMaxTokens,
                        timeout: Self.timelineGenerationTimeout
                    )
                )
                let combined = plan.prefill + text
                Self.logModelOutput(stage: "single", prefill: plan.prefill, text: text)
                let object: [String: Any]
                do {
                    object = try Self.timelineDraftObject(from: combined)
                } catch {
                    Self.logModelOutput(stage: "single.parse_failure", prefill: plan.prefill, text: text)
                    throw error
                }
                DispatchQueue.main.async { call.resolve(object) }
            } catch LlamaTextGenerationError.timeout {
                DispatchQueue.main.async { call.reject("Timeline generation timed out", "generation_timeout") }
            } catch LlamaTextGenerationError.chatTemplateUnavailable {
                DispatchQueue.main.async { call.reject("Model has no embedded chat template", "chat_template_unavailable") }
            } catch let error as TimelineGenerationParseError {
                DispatchQueue.main.async { call.reject(error.localizedDescription, "invalid_json") }
            } catch {
                DispatchQueue.main.async { call.reject(error.localizedDescription, "generation_failed") }
            }
        }
    }

    private func emit(_ snap: ModelDownloadSnapshot, event: String) {
        var payload = snap.jsObject()
        payload["emittedAt"] = Date().timeIntervalSince1970 * 1000.0
        DispatchQueue.main.async {
            self.notifyListeners(event, data: payload)
        }
    }

    struct TimelineGenerationPlan {
        let messages: [LlamaChatMessage]
        let prefill: String
    }

    private static let timelineBatchSystemPrompt: String = """
    You are an on-device assistant that summarizes one ambient transcript window into one timeline card.
    Output a single minified JSON object that matches this exact shape and nothing else:
    {"decisions":[{"action":"create","sourceWindowIds":["<window_id>"],"title":"<short title>","summary":"<one sentence>","importance":"<low|medium|high>","occurredAt":"<startedAt>"}]}

    Rules:
    - Output ONLY the JSON object. No markdown, no thinking, no commentary.
    - Use "create" when the window contains useful human activity (conversation, decision, plan, task, learning).
    - If the window has no useful activity (silence, ambient noise, empty), output: {"decisions":[{"action":"skip","sourceWindowIds":["<window_id>"],"reason":"<short>"}]}
    - "sourceWindowIds" MUST contain the exact window_id from the input verbatim.
    - "title" MUST be a SHORT headline <= 30 characters. Summarize the topic, do NOT copy the input text. NEVER output the literal string "title". NEVER copy the raw context. NEVER include labels like "Motion context:" or "Sound context:" in the title.
    - "summary" MUST be ONE short sentence <= 100 characters, summarizing what happened. Do NOT copy the input text verbatim. NEVER output the literal string "summary". NEVER include labels like "Motion context:" or "Sound context:" in the summary.
    - "title" and "summary" MUST be different from each other.
    - "importance" MUST be exactly one of: "low", "medium", "high".
    - "occurredAt" MUST be the input's started_at value copied verbatim (ISO-8601). NEVER output the literal string "iso".
    - The example below uses <PLACEHOLDER> tokens. Tokens like <TITLE_HERE>, <SUMMARY_HERE> are illustrative only and MUST be replaced with content derived from the real input. NEVER output any "<...>" placeholder verbatim and NEVER copy example token wording.
    - If the real input is in Chinese, write title and summary in Chinese. If the real input is in English, write them in English. Mirror the language of the real input.
    /no_think
    """

    private static let timelineSingleSystemPrompt: String = """
    You are an on-device assistant that summarizes one ambient transcript window into a timeline card draft.
    Output a single minified JSON object that matches this exact shape and nothing else:
    {"title":"<short title>","summary":"<one sentence>","eventType":"<conversation|meeting|focus|social|other>","confidence":<float between 0 and 1>,"confidenceLabel":"<certain|probable|uncertain>","tags":["<tag>"],"salientFacts":["<fact>"]}

    Rules:
    - Output ONLY the JSON object. No markdown, no thinking, no commentary.
    - "title" MUST be <= 60 characters, written in your own words. NEVER output the literal string "title".
    - "summary" MUST be one sentence <= 200 characters, written in your own words. NEVER output the literal string "summary".
    - "eventType" MUST be exactly one of: "conversation", "meeting", "focus", "social", "other".
    - "confidenceLabel" MUST be exactly one of: "certain", "probable", "uncertain".
    - The example below uses <PLACEHOLDER> tokens. Tokens like <TITLE_HERE>, <SUMMARY_HERE> are illustrative only and MUST be replaced with content derived from the real input. NEVER output any "<...>" placeholder verbatim and NEVER copy example token wording.
    - If the real input is in Chinese, write title and summary in Chinese. If the real input is in English, write them in English. Mirror the language of the real input.
    /no_think
    """

    private static func timelineBatchMessages(batch: [String: Any]) -> TimelineGenerationPlan {
        let windows = batch["windows"] as? [[String: Any]] ?? []
        let primary = windows.first ?? [:]
        let id = (primary["id"] as? String) ?? ""
        let windowType = (primary["windowType"] as? String) ?? ""
        let startedAt = (primary["startedAt"] as? String) ?? ""
        let endedAt = (primary["endedAt"] as? String) ?? ""
        let context = String(((primary["compactContext"] as? String) ?? "").prefix(380))

        let exampleInput = """
        - window_id: <WINDOW_ID_HERE>
        - started_at: <STARTED_AT_HERE>
        - ended_at: <ENDED_AT_HERE>
        - window_type: <WINDOW_TYPE_HERE>
        - context: <CONTEXT_HERE>
        """
        let exampleOutput = #"{"decisions":[{"action":"create","sourceWindowIds":["<WINDOW_ID_HERE>"],"title":"<TITLE_HERE>","summary":"<SUMMARY_HERE>","importance":"<LOW_MEDIUM_OR_HIGH>","occurredAt":"<STARTED_AT_HERE>"}]}"#

        let realInput = """
        - window_id: \(id)
        - started_at: \(startedAt)
        - ended_at: \(endedAt)
        - window_type: \(windowType)
        - context: \(context)
        """

        let userContent = """
        Example input:
        \(exampleInput)

        Example output:
        \(exampleOutput)

        Now process this real input. Use its real window_id and started_at verbatim. Do not copy any value from the example.

        Real input:
        \(realInput)
        """

        let messages: [LlamaChatMessage] = [
            LlamaChatMessage(role: "system", content: timelineBatchSystemPrompt),
            LlamaChatMessage(role: "user", content: userContent),
        ]
        return TimelineGenerationPlan(messages: messages, prefill: "{\"decisions\":[{")
    }

    private static func timelineSingleMessages(window: [String: Any]) -> TimelineGenerationPlan {
        let startedAt = (window["startedAt"] as? String) ?? ""
        let endedAt = (window["endedAt"] as? String) ?? ""
        let sourceTypes = (window["sourceTypes"] as? [String])?.joined(separator: ", ") ?? ""
        let context = String(((window["compactContext"] as? String) ?? "").prefix(600))

        let exampleInput = """
        - started_at: <STARTED_AT_HERE>
        - ended_at: <ENDED_AT_HERE>
        - source_types: <SOURCE_TYPES_HERE>
        - context: <CONTEXT_HERE>
        """
        let exampleOutput = #"{"title":"<TITLE_HERE>","summary":"<SUMMARY_HERE>","eventType":"<conversation|meeting|focus|social|other>","confidence":<FLOAT_0_TO_1>,"confidenceLabel":"<certain|probable|uncertain>","tags":["<TAG_HERE>"],"salientFacts":["<FACT_HERE>"]}"#

        let realInput = """
        - started_at: \(startedAt)
        - ended_at: \(endedAt)
        - source_types: \(sourceTypes)
        - context: \(context)
        """

        let userContent = """
        Example input:
        \(exampleInput)

        Example output:
        \(exampleOutput)

        Now process this real input. Do not copy any value from the example.

        Real input:
        \(realInput)
        """

        let messages: [LlamaChatMessage] = [
            LlamaChatMessage(role: "system", content: timelineSingleSystemPrompt),
            LlamaChatMessage(role: "user", content: userContent),
        ]
        return TimelineGenerationPlan(messages: messages, prefill: "{")
    }

    private static func timelineDraftObject(from text: String) throws -> [String: Any] {
        guard let json = extractJSONObjectString(from: text),
              let data = json.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TimelineGenerationParseError.invalidJSON
        }
        return object
    }

    private static func logModelOutput(stage: String, prefill: String, text: String) {
        let prefillEscaped = prefill.replacingOccurrences(of: "\n", with: "\\n")
        let textEscaped = text.replacingOccurrences(of: "\n", with: "\\n")
        print("[AmbientModels] timeline.\(stage) prefill_len=\(prefill.count) text_len=\(text.count) prefill=<<<\(prefillEscaped)>>> text=<<<\(textEscaped)>>>")
    }

    private static func extractJSONObjectString(from text: String) -> String? {
        let scalars = Array(text.unicodeScalars)
        guard let start = scalars.firstIndex(of: "{") else { return nil }
        var stack: [Unicode.Scalar] = []
        var inString = false
        var escaped = false
        for index in start..<scalars.count {
            let scalar = scalars[index]
            if escaped {
                escaped = false
                continue
            }
            if scalar == "\\" && inString {
                escaped = true
                continue
            }
            if scalar == "\"" {
                inString.toggle()
                continue
            }
            if inString { continue }
            if scalar == "{" || scalar == "[" {
                stack.append(scalar)
            } else if scalar == "}" {
                if stack.last == "{" { stack.removeLast() }
            } else if scalar == "]" {
                if stack.last == "[" { stack.removeLast() }
            }
            if stack.isEmpty && (scalar == "}" || scalar == "]") {
                return String(String.UnicodeScalarView(scalars[start...index]))
            }
        }
        var recovered = Array(scalars[start..<scalars.count])
        if inString {
            recovered.append("\"")
        }
        while let last = recovered.last, last == "," || last == " " || last == "\n" || last == "\t" || last == "\r" {
            recovered.removeLast()
        }
        if recovered.last == ":" {
            return nil
        }
        while let opener = stack.popLast() {
            recovered.append(opener == "{" ? "}" : "]")
        }
        return String(String.UnicodeScalarView(recovered))
    }
}

private enum TimelineGenerationParseError: LocalizedError {
    case invalidJSON

    var errorDescription: String? {
        "Could not extract a JSON object from model output."
    }
}

extension AmbientModelsPlugin: @unchecked Sendable {}

private func makeVerifyEngine() -> ModelVerifyEngine {
    DispatchingVerifyEngine(
        header: HeaderOnlyVerifyEngine(),
        llama: LlamaVerifyEngine(prompt: "Say hi in one word",
                                 maxTokens: 16,
                                 timeout: 60)
    )
}

private final class WeakRef<T: AnyObject>: @unchecked Sendable {
    weak var value: T?
    init(_ value: T) { self.value = value }
}
