import ExpoModulesCore
import Foundation

/**
 * AmbientModelsModule — capacitor-plugins/ambient-ai 的 AmbientModelsPlugin 的 Expo 对应物。
 * 端侧模型管理（whisper.cpp ASR + llama.cpp LLM 的 下载/校验/删除/列表/时间线生成）。
 * 核心 Swift（ModelStore / ModelDownloader / ModelVerifier / LlamaTextGenerationEngine /
 * ModelManifest）从 Capacitor 插件零改动复制；本文件只把桥接换成 ExpoModulesCore：
 *   CAPPluginCall→函数参数、call.resolve→return、call.reject→throw、notifyListeners→sendEvent。
 * timeline prompt / JSON 提取逐字照搬原插件，行为一致。
 */
public final class AmbientModelsModule: Module {
  private static let timelineBatchMaxTokens = 512
  private static let timelineSingleMaxTokens = 512
  private static let timelineGenerationTimeout: TimeInterval = 180

  private let store = ModelStore()
  private lazy var downloader = ModelDownloader(store: store)
  private let verifyEngine: ModelVerifyEngine = makeAmbientModelsVerifyEngine()
  private let textGenerator: LlamaTextGenerating = LlamaTextGenerationEngine()
  private var callbacksWired = false

  public func definition() -> ModuleDefinition {
    Name("AmbientModels")
    Events("modelDownloadProgress", "modelDownloadDone")

    OnCreate {
      self.wireCallbacksIfNeeded()
    }

    AsyncFunction("listModels") { () async -> [String: Any] in
      self.wireCallbacksIfNeeded()
      let profiles = ModelManifest.profiles
      var statuses: [[String: Any]] = []
      for profile in profiles {
        let snap = await self.downloader.status(for: profile)
        statuses.append(snap.jsObject())
      }
      return [
        "profiles": profiles.map { $0.jsObject() },
        "statuses": statuses,
      ]
    }

    AsyncFunction("startModelDownload") { (options: [String: Any]) async throws in
      self.wireCallbacksIfNeeded()
      guard let id = options["id"] as? String,
            let profile = ModelManifest.profile(forId: id) else {
        throw AmbientModelsException("Unknown model id")
      }
      let mirror = ModelMirror(rawValue: options["preferredMirror"] as? String ?? "") ?? .hfMirror
      await self.downloader.start(profile: profile, preferredMirror: mirror)
    }

    AsyncFunction("cancelModelDownload") { (options: [String: Any]) async throws in
      guard let id = options["id"] as? String else {
        throw AmbientModelsException("Missing id")
      }
      await self.downloader.cancel(id: id)
    }

    AsyncFunction("deleteModel") { (options: [String: Any]) async throws in
      guard let id = options["id"] as? String,
            let profile = ModelManifest.profile(forId: id) else {
        throw AmbientModelsException("Unknown model id")
      }
      _ = await self.store.remove(profile)
      await self.downloader.clearVerifyState(profileId: id, presentAfter: false)
      let snap = await self.downloader.status(for: profile)
      self.sendEventOnMain("modelDownloadDone", snap.jsObject())
    }

    AsyncFunction("verifyModel") { (options: [String: Any]) async throws -> [String: Any] in
      guard let id = options["id"] as? String,
            let profile = ModelManifest.profile(forId: id) else {
        throw AmbientModelsException("Unknown model id")
      }
      let present = await self.store.isPresent(profile)
      if !present {
        return ["id": id, "ok": false, "elapsedMs": 0, "errorMessage": "Model not downloaded"]
      }
      await self.downloader.markVerifying(profileId: id)
      let path = await self.store.fileURL(for: profile)
      let outcome = await self.verifyEngine.verify(profile: profile, path: path)
      await self.downloader.recordVerifyResult(
        profileId: id, ok: outcome.ok, output: outcome.output, error: outcome.errorMessage)
      let snap = await self.downloader.status(for: profile)
      self.sendEventOnMain("modelDownloadProgress", snap.jsObject())
      var result: [String: Any] = ["id": id, "ok": outcome.ok, "elapsedMs": outcome.elapsedMs]
      if let output = outcome.output { result["output"] = output }
      if let err = outcome.errorMessage { result["errorMessage"] = err }
      return result
    }

    AsyncFunction("generateTimelineEvent") { (options: [String: Any]) async throws -> [String: Any] in
      try await self.generateTimeline(options: options, batch: false)
    }

    AsyncFunction("generateTimelineBatchDecision") { (options: [String: Any]) async throws -> [String: Any] in
      try await self.generateTimeline(options: options, batch: true)
    }
  }

  // MARK: - download callbacks → sendEvent

  private func wireCallbacksIfNeeded() {
    if callbacksWired { return }
    callbacksWired = true
    let weakSelf = AmbientModelsWeakRef(self)
    Task { [downloader] in
      await downloader.setCallbacks(
        progress: { snap in weakSelf.value?.emit(snap, event: "modelDownloadProgress") },
        done: { snap in weakSelf.value?.emit(snap, event: "modelDownloadDone") }
      )
    }
  }

  private func emit(_ snap: ModelDownloadSnapshot, event: String) {
    var payload = snap.jsObject()
    payload["emittedAt"] = Date().timeIntervalSince1970 * 1000.0
    sendEventOnMain(event, payload)
  }

  private func sendEventOnMain(_ event: String, _ payload: [String: Any]) {
    DispatchQueue.main.async { self.sendEvent(event, payload) }
  }

  // MARK: - timeline generation (single + batch 共享，对应原插件两个近乎相同的方法)

  private func generateTimeline(options: [String: Any], batch: Bool) async throws -> [String: Any] {
    guard let id = options["modelId"] as? String else {
      throw AmbientModelsException("Missing modelId")
    }
    guard let profile = ModelManifest.profile(forId: id) else {
      throw AmbientModelsException("Unknown model id")
    }
    guard profile.kind == .llm else {
      throw AmbientModelsException("Selected model is not an LLM")
    }
    let present = await store.isPresent(profile)
    guard present else { throw AmbientModelsException("Model not downloaded") }
    let status = await downloader.status(for: profile)
    guard status.lastVerifyResult == "ok" else {
      throw AmbientModelsException("Model must be verified before timeline generation")
    }
    let path = await store.fileURL(for: profile)
    let plan = batch
      ? Self.timelineBatchMessages(batch: options["batch"] as? [String: Any] ?? [:])
      : Self.timelineSingleMessages(window: options["window"] as? [String: Any] ?? [:])
    let maxTokens = batch ? Self.timelineBatchMaxTokens : Self.timelineSingleMaxTokens
    do {
      let text = try await textGenerator.generate(
        modelURL: path,
        messagesOptions: LlamaTextGenerationMessagesOptions(
          messages: plan.messages,
          assistantPrefill: plan.prefill,
          maxTokens: maxTokens,
          timeout: Self.timelineGenerationTimeout
        )
      )
      let combined = plan.prefill + text
      Self.logModelOutput(stage: batch ? "batch" : "single", prefill: plan.prefill, text: text)
      let object: [String: Any]
      do {
        object = try Self.timelineDraftObject(from: combined)
      } catch {
        Self.logModelOutput(stage: batch ? "batch.parse_failure" : "single.parse_failure", prefill: plan.prefill, text: text)
        throw error
      }
      if batch {
        guard object["decisions"] is [[String: Any]] else {
          Self.logModelOutput(stage: "batch.shape_failure", prefill: plan.prefill, text: text)
          throw TimelineGenerationParseError.invalidJSON
        }
      }
      return object
    } catch LlamaTextGenerationError.timeout {
      throw AmbientModelsException("Timeline generation timed out")
    } catch LlamaTextGenerationError.chatTemplateUnavailable {
      throw AmbientModelsException("Model has no embedded chat template")
    } catch let error as AmbientModelsException {
      throw error
    } catch let error as TimelineGenerationParseError {
      throw AmbientModelsException(error.localizedDescription)
    } catch {
      throw AmbientModelsException(error.localizedDescription)
    }
  }

  struct TimelineGenerationPlan {
    let messages: [LlamaChatMessage]
    let prefill: String
  }

  // 以下 prompt / 消息构造 / JSON 提取，逐字照搬 AmbientModelsPlugin（纯 Swift，无桥接）。

  private static let timelineBatchSystemPrompt: String = """
  You are an on-device assistant that summarizes one ambient transcript window into one timeline card.
  Output a single minified JSON object that matches this exact shape and nothing else:
  {"decisions":[{"action":"create","sourceWindowIds":["<window_id>"],"title":"<short title>","summary":"<one sentence>","importance":"<low|medium|high>","occurredAt":"<startedAt>","act":{"l":"<short verb phrase>","g":"<one-sentence goal>","b":"<basket>"}}]}

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
  - "act" is OPTIONAL. Include it ONLY when the window suggests a concrete next step the user can act on right now. If there is no clear actionable next step, OMIT the "act" field entirely. Do NOT emit "act":{} and do NOT echo any "<...>" placeholder verbatim.
  - When you include "act": "l" MUST be a short verb phrase <= 24 characters; "g" MUST be ONE sentence <= 100 characters stating the goal in concrete terms; "b" is optional and MUST be exactly one of: "work", "health", "family", "wealth", "growth", "life".
  - "g" MUST be different from "summary". "l" MUST be different from "title" and from "summary". NEVER include labels like "Motion context:" or "Sound context:" in "l" or "g".
  - The example below uses <PLACEHOLDER> tokens. Tokens like <TITLE_HERE>, <SUMMARY_HERE>, <LABEL_HERE>, <GOAL_HERE>, <BASKET_HERE> are illustrative only and MUST be replaced with content derived from the real input. NEVER output any "<...>" placeholder verbatim and NEVER copy example token wording.
  - If the real input is in Chinese, write title, summary, and "act" fields in Chinese. If the real input is in English, write them in English. Mirror the language of the real input.
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
    let exampleOutput = #"{"decisions":[{"action":"create","sourceWindowIds":["<WINDOW_ID_HERE>"],"title":"<TITLE_HERE>","summary":"<SUMMARY_HERE>","importance":"<LOW_MEDIUM_OR_HIGH>","occurredAt":"<STARTED_AT_HERE>","act":{"l":"<LABEL_HERE>","g":"<GOAL_HERE>","b":"<BASKET_HERE>"}}]}"#

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

/// Expo 异常：把 message 透传到 JS reject（原插件用 call.reject(msg, code)，Expo 用 throw）。
internal final class AmbientModelsException: GenericException<String> {
  override var reason: String { param }
}

private func makeAmbientModelsVerifyEngine() -> ModelVerifyEngine {
  DispatchingVerifyEngine(
    header: HeaderOnlyVerifyEngine(),
    llama: LlamaVerifyEngine(prompt: "Say hi in one word", maxTokens: 16, timeout: 60)
  )
}

private final class AmbientModelsWeakRef<T: AnyObject>: @unchecked Sendable {
  weak var value: T?
  init(_ value: T) { self.value = value }
}
