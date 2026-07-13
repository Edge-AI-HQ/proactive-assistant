import Foundation

/// Streaming client for Tencent Real-Time ASR WebSocket v2.
///
/// The api service mints a short-lived signed URL
/// (`/api/voice/hardware/tencent-token`); this client opens the socket,
/// forwards PCM audio chunks from the MR20 recorder, and re-broadcasts
/// interim/final recognition results through the supplied callbacks.
///
/// One instance per capture session. `open` must be called before
/// `sendAudio`; `close` cleans up and idempotently cancels the task.
final class TencentAsrClient: NSObject, URLSessionWebSocketDelegate {
    struct RecognitionResult {
        let text: String
        let isFinal: Bool
        let voiceId: String
        let sliceIndex: Int
        let startMs: Int?
        let endMs: Int?
    }

    struct Callbacks {
        let onResult: (RecognitionResult) -> Void
        let onError: (Error) -> Void
        let onClose: () -> Void
    }

    private let url: URL
    private let callbacks: Callbacks
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private let workQueue = DispatchQueue(label: "ai.pin.tencent-asr", qos: .utility)
    private var isOpen = false
    private var didFinish = false

    init(url: URL, callbacks: Callbacks) {
        self.url = url
        self.callbacks = callbacks
    }

    func open() {
        workQueue.async { [weak self] in
            guard let self, !self.isOpen else { return }
            self.isOpen = true
            let config = URLSessionConfiguration.default
            config.waitsForConnectivity = false
            let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
            self.session = session
            let task = session.webSocketTask(with: self.url)
            self.task = task
            task.resume()
            self.receiveNext()
        }
    }

    func sendAudio(_ data: Data) {
        guard !data.isEmpty else { return }
        workQueue.async { [weak self] in
            guard let self, self.isOpen, let task = self.task else { return }
            task.send(.data(data)) { [weak self] error in
                if let error {
                    self?.finish(with: error)
                }
            }
        }
    }

    /// Tencent's end-of-stream marker per RTASR v2 spec.
    func sendEndOfStream() {
        workQueue.async { [weak self] in
            guard let self, self.isOpen, let task = self.task else { return }
            let payload = "{\"type\":\"end\"}"
            task.send(.string(payload)) { [weak self] error in
                if let error {
                    self?.finish(with: error)
                }
            }
        }
    }

    func close() {
        workQueue.async { [weak self] in
            self?.finish(with: nil)
        }
    }

    // MARK: - URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        workQueue.async { [weak self] in
            self?.finish(with: nil)
        }
    }

    func urlSession(_ session: URLSession,
                    task: URLSessionTask,
                    didCompleteWithError error: Error?) {
        workQueue.async { [weak self] in
            self?.finish(with: error)
        }
    }

    // MARK: - Private

    private func receiveNext() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.workQueue.async { self.finish(with: error) }
            case .success(let message):
                self.workQueue.async {
                    self.handleMessage(message)
                    if !self.didFinish {
                        self.receiveNext()
                    }
                }
            }
        }
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .string(let text):
            processFrame(text)
        case .data(let data):
            if let text = String(data: data, encoding: .utf8) {
                processFrame(text)
            }
        @unknown default:
            break
        }
    }

    private func processFrame(_ text: String) {
        switch Self.parseFrame(text) {
        case .none:
            return
        case .error(let error):
            finish(with: error)
        case .result(let recognition, let sessionEnded):
            callbacks.onResult(recognition)
            if sessionEnded {
                finish(with: nil)
            }
        }
    }

    enum ParsedFrame {
        case none
        case result(RecognitionResult, sessionEnded: Bool)
        case error(Error)
    }

    /// Pure decoding of a Tencent RTASR v2 frame — extracted so tests can
    /// pin the schema without spinning up a real WebSocket.
    static func parseFrame(_ text: String) -> ParsedFrame {
        guard let payload = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
            return .none
        }
        if let code = json["code"] as? Int, code != 0 {
            let msg = (json["message"] as? String) ?? "tencent_asr_error(\(code))"
            let err = NSError(
                domain: "TencentAsrClient",
                code: code,
                userInfo: [NSLocalizedDescriptionKey: msg]
            )
            return .error(err)
        }
        guard
            let result = json["result"] as? [String: Any],
            let sliceType = (result["slice_type"] as? Int) ?? (result["sliceType"] as? Int)
        else {
            return .none
        }
        let voiceId = (json["voice_id"] as? String) ?? ""
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
        )
        let sessionEnded = (json["final"] as? Int) == 1
        return .result(recognition, sessionEnded: sessionEnded)
    }

    private func finish(with error: Error?) {
        if didFinish { return }
        didFinish = true
        isOpen = false
        if let error {
            callbacks.onError(error)
        }
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.finishTasksAndInvalidate()
        session = nil
        callbacks.onClose()
    }
}
