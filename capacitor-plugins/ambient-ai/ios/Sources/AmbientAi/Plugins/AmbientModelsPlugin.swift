@preconcurrency import Capacitor
import Foundation

@objc(AmbientModelsPlugin)
public class AmbientModelsPlugin: CAPPlugin, CAPBridgedPlugin {
    private static let timelineBatchMaxTokens = 96
    private static let timelineSingleMaxTokens = 128
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
                let prompt = Self.timelineBatchPrompt(batch: batch)
                let text = try await textGenerator.generate(
                    modelURL: path,
                    options: LlamaTextGenerationOptions(prompt: prompt, maxTokens: Self.timelineBatchMaxTokens, timeout: Self.timelineGenerationTimeout)
                )
                let object = try Self.timelineDraftObject(from: text)
                guard object["decisions"] is [[String: Any]] else {
                    throw TimelineGenerationParseError.invalidJSON
                }
                DispatchQueue.main.async { call.resolve(object) }
            } catch LlamaTextGenerationError.timeout {
                DispatchQueue.main.async { call.reject("Timeline generation timed out", "generation_timeout") }
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
                let prompt = Self.timelinePrompt(window: window)
                let text = try await textGenerator.generate(
                    modelURL: path,
                    options: LlamaTextGenerationOptions(prompt: prompt, maxTokens: Self.timelineSingleMaxTokens, timeout: Self.timelineGenerationTimeout)
                )
                let object = try Self.timelineDraftObject(from: text)
                DispatchQueue.main.async { call.resolve(object) }
            } catch LlamaTextGenerationError.timeout {
                DispatchQueue.main.async { call.reject("Timeline generation timed out", "generation_timeout") }
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

    private static func timelineBatchPrompt(batch: [String: Any]) -> String {
        let windows = batch["windows"] as? [[String: Any]] ?? []
        let recentCards = batch["recentLlmCards"] as? [[String: Any]] ?? []
        let ruleContext = batch["ruleContext"] as? [[String: Any]] ?? []
        let windowsText = windows.prefix(1).map { window in
            let id = (window["id"] as? String) ?? ""
            let windowType = (window["windowType"] as? String) ?? ""
            let startedAt = (window["startedAt"] as? String) ?? ""
            let endedAt = (window["endedAt"] as? String) ?? ""
            let context = String(((window["compactContext"] as? String) ?? "").prefix(480))
            return "- id: \(id) type: \(windowType) start: \(startedAt) end: \(endedAt) context: \(context)"
        }.joined(separator: "\n")
        let recentText = recentCards.prefix(2).map { card in
            let id = (card["id"] as? String) ?? ""
            let title = (card["title"] as? String) ?? ""
            let summary = String(((card["summary"] as? String) ?? "").prefix(120))
            return "- id: \(id) title: \(title) summary: \(summary)"
        }.joined(separator: "\n")
        let ruleText = ruleContext.prefix(2).map { card in
            let title = (card["title"] as? String) ?? ""
            let summary = String(((card["summary"] as? String) ?? "").prefix(120))
            return "- \(title): \(summary)"
        }.joined(separator: "\n")
        return """
        You summarize ambient windows into compact Timeline decisions.
        Return only JSON: {"decisions":[...]}
        Decision forms use short keys:
        create: {"a":"create","w":["window_id"],"t":"title","s":"summary","i":"medium","occurredAt":"iso"}
        update: {"a":"update","e":"event_id","w":["window_id"],"s":"new summary"}
        skip: {"a":"skip","w":["window_id"],"r":"reason"}
        Cover every input window exactly once. Never update rule context.
        Windows:
        \(windowsText)
        Recent LLM cards eligible for update:
        \(recentText)
        Rule context:
        \(ruleText)
        """
    }

    private static func timelinePrompt(window: [String: Any]) -> String {
        let context = String(((window["compactContext"] as? String) ?? "").prefix(700))
        let startedAt = (window["startedAt"] as? String) ?? ""
        let endedAt = (window["endedAt"] as? String) ?? ""
        let sourceTypes = (window["sourceTypes"] as? [String])?.joined(separator: ", ") ?? ""
        return """
        You summarize ambient transcript windows into one JSON object.
        Return only JSON with keys: title, summary, eventType, confidence, confidenceLabel, tags, salientFacts.
        eventType must be one of conversation, meeting, focus, social, other.
        confidence is a number between 0 and 1. confidenceLabel is certain or uncertain.
        Window startedAt: \(startedAt)
        Window endedAt: \(endedAt)
        Source types: \(sourceTypes)
        Context:
        \(context)
        """
    }

    private static func timelineDraftObject(from text: String) throws -> [String: Any] {
        guard let json = extractJSONObjectString(from: text),
              let data = json.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TimelineGenerationParseError.invalidJSON
        }
        return object
    }

    private static func extractJSONObjectString(from text: String) -> String? {
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start <= end else {
            return nil
        }
        return String(text[start...end])
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
