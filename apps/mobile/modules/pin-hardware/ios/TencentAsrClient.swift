import Foundation

/// Streaming client for Tencent Real-Time ASR WebSocket v2.
///
/// The api service mints a short-lived signed URL
/// (`/api/voice/hardware/tencent-token`); this client opens the socket,
/// forwards MP3 audio chunks from the MR20 recorder, and re-broadcasts
/// interim/final recognition results through the supplied callbacks.
///
/// One instance per capture session. `open` must be called before
/// `sendAudio`; `close` cleans up and idempotently cancels the task.
final class TencentAsrClient: NSObject {
    struct RecognitionSegment {
        let sentenceId: Int
        let speakerId: String?
        let text: String
        let isFinal: Bool
        let startMs: Int?
        let endMs: Int?
    }

    struct RecognitionResult {
        let text: String
        let isFinal: Bool
        let voiceId: String
        let sliceIndex: Int
        let startMs: Int?
        let endMs: Int?
        let segments: [RecognitionSegment]
        let speakerContextId: String?
    }

    struct Callbacks {
        let onOpen: () -> Void
        let onSpeakerContext: (String) -> Void
        let onResult: (RecognitionResult) -> Void
        let onError: (Error) -> Void
        let onClose: () -> Void
    }

    private let url: URL
    private let callbacks: Callbacks
    private var transport: PinHardwareWebSocketTransport?
    private let workQueue = DispatchQueue(label: "ai.pin.tencent-asr", qos: .utility)
    private var isOpen = false
    private var didFinish = false
    private var didSignalReady = false

    init(url: URL, callbacks: Callbacks) {
        self.url = url
        self.callbacks = callbacks
    }

    func open() {
        workQueue.async { [weak self] in
            guard let self, !self.isOpen else { return }
            self.isOpen = true
            let transport = PinHardwareWebSocketTransport(url: self.url)
            transport.onOpen = { [weak self] in
                self?.workQueue.async {
                    guard let self, !self.didFinish else { return }
                    NSLog("[pin-hardware] tencent asr websocket transport open")
                }
            }
            transport.onText = { [weak self] text in
                self?.workQueue.async {
                    guard let self, !self.didFinish else { return }
                    self.processFrame(text)
                }
            }
            transport.onData = { [weak self] data in
                self?.workQueue.async {
                    guard let self, !self.didFinish,
                          let text = String(data: data, encoding: .utf8)
                    else { return }
                    self.processFrame(text)
                }
            }
            transport.onError = { [weak self] error in
                self?.workQueue.async { self?.finish(with: error) }
            }
            transport.onClose = { [weak self] code, reason in
                self?.workQueue.async {
                    guard let self, !self.didFinish else { return }
                    let suffix = reason?.isEmpty == false ? ": \(reason!)" : ""
                    self.finish(with: NSError(
                        domain: "TencentAsrClient.WebSocket",
                        code: code,
                        userInfo: [NSLocalizedDescriptionKey: "WebSocket closed (\(code))\(suffix)"]
                    ))
                }
            }
            self.transport = transport
            transport.open()
        }
    }

    func sendAudio(_ data: Data) {
        guard !data.isEmpty else { return }
        workQueue.async { [weak self] in
            guard let self, self.isOpen, let transport = self.transport else { return }
            transport.send(data: data)
        }
    }

    /// Tencent's end-of-stream marker per RTASR v2 spec.
    func sendEndOfStream() {
        workQueue.async { [weak self] in
            guard let self, self.isOpen, let transport = self.transport else { return }
            let payload = "{\"type\":\"end\"}"
            transport.send(text: payload)
        }
    }

    func close() {
        workQueue.async { [weak self] in
            self?.finish(with: nil)
        }
    }

    // MARK: - Private

    private func processFrame(_ text: String) {
        switch Self.parseFrame(text) {
        case .none:
            return
        case .ready:
            if !didSignalReady {
                didSignalReady = true
                callbacks.onOpen()
            }
        case .error(let error):
            finish(with: error)
        case .speakerContext(let contextId):
            callbacks.onSpeakerContext(contextId)
        case .result(let recognition):
            callbacks.onResult(recognition)
        }
    }

    enum ParsedFrame {
        case none
        case ready
        case speakerContext(String)
        case result(RecognitionResult)
        case error(Error)
    }

    /// Pure decoding of a Tencent RTASR v2 frame — extracted so tests can
    /// pin the schema without spinning up a real WebSocket.
    static func parseFrame(_ text: String) -> ParsedFrame {
        guard let payload = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
            return .none
        }
        if let code = Self.intValue(json["code"]), code != 0 {
            let msg = (json["message"] as? String) ?? "tencent_asr_error(\(code))"
            let err = NSError(
                domain: "TencentAsrClient",
                code: code,
                userInfo: [NSLocalizedDescriptionKey: msg]
            )
            return .error(err)
        }
        if Self.intValue(json["code"]) == 0,
           json["result"] == nil,
           json["sentences"] == nil {
            return .ready
        }
        let voiceId = (json["voice_id"] as? String) ?? ""
        let speakerContextId = (json["speaker_context_id"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if let sentences = json["sentences"] as? [String: Any] {
            let sentenceList = (sentences["sentence_list"] as? [[String: Any]])
                ?? (sentences["sentence"] != nil || sentences["text"] != nil ? [sentences] : [])
            let segments = sentenceList.enumerated().compactMap { index, sentence -> RecognitionSegment? in
                let recognizedText = (sentence["sentence"] as? String)
                    ?? (sentence["text"] as? String)
                    ?? ""
                guard !recognizedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    return nil
                }
                let sentenceId = Self.intValue(sentence["sentence_id"])
                    ?? Self.intValue(sentence["sentenceId"])
                    ?? index
                let speakerId = Self.intValue(sentence["speaker_id"])
                    .map(String.init)
                    ?? (sentence["speaker_id"] as? String)
                return RecognitionSegment(
                    sentenceId: sentenceId,
                    speakerId: speakerId,
                    text: recognizedText,
                    isFinal: (
                        Self.intValue(sentence["sentence_type"])
                            ?? Self.intValue(sentence["sentenceType"])
                            ?? 0
                    ) == 1,
                    startMs: Self.intValue(sentence["start_time"])
                        ?? Self.intValue(sentence["startTime"]),
                    endMs: Self.intValue(sentence["end_time"])
                        ?? Self.intValue(sentence["endTime"])
                )
            }
            if !segments.isEmpty {
                let recognizedText = (sentences["voice_text_str"] as? String)
                    ?? segments.map(\.text).joined(separator: "\n")
                return .result(RecognitionResult(
                    text: recognizedText,
                    isFinal: segments.allSatisfy(\.isFinal),
                    voiceId: voiceId,
                    sliceIndex: segments.last?.sentenceId ?? 0,
                    startMs: segments.compactMap(\.startMs).min(),
                    endMs: segments.compactMap(\.endMs).max(),
                    segments: segments,
                    speakerContextId: speakerContextId
                ))
            }
        }
        guard
            let result = json["result"] as? [String: Any],
            let sliceType = (result["slice_type"] as? Int) ?? (result["sliceType"] as? Int)
        else {
            if let speakerContextId, !speakerContextId.isEmpty {
                return .speakerContext(speakerContextId)
            }
            return .none
        }
        let sliceIndex = (result["index"] as? Int) ?? (result["voice_index"] as? Int) ?? 0
        let recognizedText = (result["voice_text_str"] as? String)
            ?? (result["voiceTextStr"] as? String)
            ?? ""
        let startMs = (result["start_time"] as? Int) ?? (result["startTime"] as? Int)
        let endMs = (result["end_time"] as? Int) ?? (result["endTime"] as? Int)
        // slice_type 0 = new segment / interim, 1 = update, 2 = final.
        // 0/1 both surface as draft in the UI.
        let recognition = RecognitionResult(
            text: recognizedText,
            isFinal: sliceType == 2,
            voiceId: voiceId,
            sliceIndex: sliceIndex,
            startMs: startMs,
            endMs: endMs,
            segments: [],
            speakerContextId: speakerContextId
        )
        // Tencent may set top-level `final=1` on a finalized recognition
        // result. It is not a transport close signal; only the WebSocket
        // delegate or an explicit error ends the session.
        return .result(recognition)
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let value = value as? Int { return value }
        if let value = value as? NSNumber { return value.intValue }
        if let value = value as? String { return Int(value) }
        return nil
    }

    private func finish(with error: Error?) {
        if didFinish { return }
        didFinish = true
        isOpen = false
        if let error {
            callbacks.onError(error)
        }
        transport?.close()
        transport = nil
        callbacks.onClose()
    }
}
