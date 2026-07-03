import AVFoundation
import ExpoModulesCore
import Foundation
import UIKit

/// Expo Module 桥 —— 替代 capacitor AudioCapturePlugin(CAPPlugin)的桥接层。
/// 核心 9 类(AudioStreamManager 等)原样迁移自 capacitor-plugins/ambient-ai/Audio,
/// 方法面与原 AudioCapturePlugin 1:1。Capacitor 桥语义 → Expo Modules DSL 的映射:
///   CAPPluginCall.getX  → AsyncFunction typed 参数
///   call.resolve(dict)  → return dict / void
///   call.reject(msg,c)  → throw Exception
///   notifyListeners     → sendEvent
public final class AmbientAudioModule: Module {
  private lazy var audioManager = AudioStreamManager(callbacks: .init(
    emitEvent: { [weak self] eventName, payload in
      DispatchQueue.main.async { self?.sendEvent(eventName, payload) }
    }
  ))
  private lazy var voicePcmStream = VoicePcmStream { [weak self] payload in
    DispatchQueue.main.async { self?.sendEvent("voicePcmChunk", payload) }
  }

  private var playbackPlayer: AVAudioPlayer?
  private var playbackDelegate: PlaybackDelegate?
  private var observers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("AmbientAudio")

    // 必须覆盖 AudioStreamManager 实际 emit 的全部事件名——Expo 会丢弃未在此
    // 声明的事件，JS 端 addListener 收不到。captureSessionRotated（会话轮换，
    // 实时转写 UI 据此重置）+ audioDiagnostic（调试遥测）此前漏声明。
    Events(
      "soundClassification",
      "captureReady",
      "captureDiscarded",
      "captureSessionRotated",
      "transcript",
      "transcriptDraft",
      "transcriptRefined",
      "transcriptReady",
      "speechBurst",
      "voicePcmChunk",
      "audioState",
      "audioError",
      "audioDiagnostic"
    )

    OnCreate {
      self.registerLifecycleObservers()
    }

    OnDestroy {
      for token in self.observers {
        NotificationCenter.default.removeObserver(token)
      }
      self.observers.removeAll()
    }

    // MARK: Permissions
    AsyncFunction("requestPermissions") { (promise: Promise) in
      switch AVAudioApplication.shared.recordPermission {
      case .granted, .denied:
        promise.resolve(self.permissionState())
      case .undetermined:
        AVAudioApplication.requestRecordPermission { _ in
          promise.resolve(self.permissionState())
        }
      @unknown default:
        promise.resolve(["microphone": "prompt", "speechRecognition": self.speechPermissionState()])
      }
    }

    AsyncFunction("checkPermissions") { () -> [String: String] in
      self.permissionState()
    }

    // MARK: Configuration
    AsyncFunction("configure") { (options: [String: Any]) in
      await self.audioManager.configure(self.makeConfig(from: options))
    }

    // MARK: Capture
    AsyncFunction("startCapture") {
      guard self.microphonePermissionState() == "granted" else {
        throw AudioCaptureException("Microphone permission not granted")
      }
      do {
        try await self.audioManager.startCapture()
      } catch {
        self.emitError(error.localizedDescription, source: "capture")
        throw error
      }
    }

    AsyncFunction("stopCapture") {
      await self.audioManager.stopCapture()
    }

    AsyncFunction("getState") { () -> [String: Any] in
      await self.audioManager.snapshot().payload
    }

    AsyncFunction("drainPendingTranscripts") { () -> [String: Any] in
      ["transcripts": await self.audioManager.drainPendingTranscripts()]
    }

    AsyncFunction("listRecentCaptures") { (limit: Int?, cursor: String?, order: String?) -> [String: Any] in
      let parsedOrder = order.flatMap(AudioCaptureListOrder.init(rawValue:)) ?? .desc
      let captures = await self.audioManager.listRecentCaptures(limit: limit, cursor: cursor, order: parsedOrder)
      return ["captures": captures]
    }

    AsyncFunction("readCapture") { (wavId: String) -> [String: Any] in
      guard !wavId.isEmpty else { throw AudioCaptureException("Missing wavId") }
      guard let url = await self.audioManager.captureURL(wavId: wavId) else {
        throw AudioCaptureException("WAV not found")
      }
      let data = try Data(contentsOf: url)
      return [
        "wavId": wavId,
        "contentType": "audio/wav",
        "base64": data.base64EncodedString(),
        "byteSize": data.count,
      ]
    }

    AsyncFunction("markCaptureProcessed") { (wavId: String) in
      guard !wavId.isEmpty else { throw AudioCaptureException("Missing wavId") }
      await self.audioManager.markCaptureProcessed(wavId: wavId)
    }

    // MARK: Playback
    AsyncFunction("playCapture") { (wavId: String) in
      guard !wavId.isEmpty else { throw AudioCaptureException("Missing wavId") }
      guard let url = await self.audioManager.captureURL(wavId: wavId) else {
        throw AudioCaptureException("WAV not found")
      }
      // Suppress classifier (tears down SoundAnalysis + deactivates session)
      // while playing back; un-suppress on finish restores it.
      await self.audioManager.setPlaybackSuppressed(true)
      let session = AVAudioSession.sharedInstance()
      do {
        try session.setCategory(.playback, mode: .default, options: [])
        try session.setActive(true, options: [])
      } catch {
        self.emitError(error.localizedDescription, source: "playback")
        await self.restoreAfterPlayback()
        throw error
      }
      try await self.startPlayback(url: url)
    }

    AsyncFunction("stopPlayback") {
      self.playbackPlayer?.stop()
      self.playbackPlayer = nil
      await self.restoreAfterPlayback()
    }

    // MARK: Classification
    AsyncFunction("startClassification") {
      guard self.microphonePermissionState() == "granted" else {
        throw AudioCaptureException("Microphone permission not granted")
      }
      do {
        try await self.audioManager.startClassification()
      } catch {
        self.emitError(error.localizedDescription, source: "soundAnalysis")
        throw error
      }
    }

    AsyncFunction("stopClassification") {
      await self.audioManager.stopClassification()
    }

    AsyncFunction("setExternalMicSuppressed") { (suppressed: Bool) in
      await self.audioManager.setExternalMicSuppressed(suppressed)
    }

    AsyncFunction("startVoicePcmStream") { (options: [String: Any]?) -> [String: Any] in
      guard self.microphonePermissionState() == "granted" else {
        throw AudioCaptureException("Microphone permission not granted")
      }
      let sampleRate = options?["sampleRate"] as? Int ?? 16_000
      let chunkDurationMs = options?["chunkDurationMs"] as? Int ?? 100
      do {
        let streamId = try self.voicePcmStream.start(
          sampleRate: sampleRate,
          chunkDurationMs: chunkDurationMs
        )
        return ["streamId": streamId]
      } catch {
        self.emitError(error.localizedDescription, source: "voicePcmStream")
        throw error
      }
    }

    AsyncFunction("stopVoicePcmStream") { (streamId: String?) in
      self.voicePcmStream.stop(streamId: streamId)
    }
  }

  // MARK: - Lifecycle observers(对照 AudioCapturePlugin.load）

  private func registerLifecycleObservers() {
    let center = NotificationCenter.default
    observers.append(center.addObserver(
      forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      Task {
        await self?.audioManager.setAppBackgrounded(false, reason: "appDidBecomeActive")
        await self?.audioManager.recoverClassifierIfNeeded(reason: "appDidBecomeActive")
      }
    })
    observers.append(center.addObserver(
      forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      Task { await self?.audioManager.setAppBackgrounded(true, reason: "appWillResignActive") }
    })
    observers.append(center.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { [weak self] _ in
      Task { await self?.audioManager.setAppBackgrounded(true, reason: "appDidEnterBackground") }
    })
    observers.append(center.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
    ) { [weak self] notification in
      let reasonValue = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
      let reason = reasonValue
        .flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
        .map(Self.routeChangeReasonName) ?? "unknown"
      Task { await self?.audioManager.noteRouteChanged(reason: reason) }
    })
  }

  // MARK: - Playback helpers

  @MainActor
  private func startPlayback(url: URL) throws {
    playbackPlayer?.stop()
    let player = try AVAudioPlayer(contentsOf: url)
    let delegate = PlaybackDelegate(
      onFinish: { [weak self] in
        self?.playbackPlayer = nil
        Task { await self?.restoreAfterPlayback() }
      },
      onError: { [weak self] error in
        self?.playbackPlayer = nil
        if let error { self?.emitError(error.localizedDescription, source: "playback") }
        Task { await self?.restoreAfterPlayback() }
      }
    )
    player.delegate = delegate
    playbackDelegate = delegate
    playbackPlayer = player
    player.prepareToPlay()
    player.play()
  }

  private func restoreAfterPlayback() async {
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    await audioManager.setPlaybackSuppressed(false)
  }

  // MARK: - Permission helpers

  private func permissionState() -> [String: String] {
    ["microphone": microphonePermissionState(), "speechRecognition": speechPermissionState()]
  }

  private func microphonePermissionState() -> String {
    switch AVAudioApplication.shared.recordPermission {
    case .granted: return "granted"
    case .denied: return "denied"
    case .undetermined: return "prompt"
    @unknown default: return "prompt"
    }
  }

  private func speechPermissionState() -> String {
    // Local SFSpeech transcription dormant; don't touch Speech APIs on startup path.
    "prompt"
  }

  // MARK: - Helpers

  private func emitError(_ message: String, source: String) {
    DispatchQueue.main.async { [weak self] in
      self?.sendEvent("audioError", ["message": message, "source": source])
    }
  }

  private static func routeChangeReasonName(_ reason: AVAudioSession.RouteChangeReason) -> String {
    switch reason {
    case .newDeviceAvailable: return "new_device_available"
    case .oldDeviceUnavailable: return "old_device_unavailable"
    case .categoryChange: return "category_change"
    case .override: return "override"
    case .wakeFromSleep: return "wake_from_sleep"
    case .noSuitableRouteForCategory: return "no_suitable_route_for_category"
    case .routeConfigurationChange: return "route_configuration_change"
    case .unknown: return "unknown"
    @unknown default: return "unknown"
    }
  }

  private func makeConfig(from o: [String: Any]) -> AudioCaptureConfig {
    let cloudMode = (o["cloudMode"] as? String).flatMap(AudioCloudMode.init(rawValue:)) ?? .off
    let baseURL = (o["cloudBaseURL"] as? String).flatMap { value -> URL? in
      let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : URL(string: trimmed)
    }
    return AudioCaptureConfig(
      cloudMode: cloudMode,
      recognitionLocale: o["recognitionLocale"] as? String,
      cloudApiKey: o["cloudApiKey"] as? String,
      cloudBaseURL: baseURL,
      modelName: (o["modelName"] as? String) ?? AudioCaptureConfig.defaultModelName,
      cloudRefineTimeoutMs: (o["cloudRefineTimeoutMs"] as? Int) ?? AudioCaptureConfig.defaultCloudRefineTimeoutMs,
      preRollMs: (o["preRollMs"] as? Int) ?? AudioCaptureConfig.defaultPreRollMs,
      postRollMs: (o["postRollMs"] as? Int) ?? AudioCaptureConfig.defaultPostRollMs,
      maxBurstMs: (o["maxBurstMs"] as? Int) ?? AudioCaptureConfig.defaultMaxBurstMs,
      minBurstMs: (o["minBurstMs"] as? Int) ?? AudioCaptureConfig.defaultMinBurstMs,
      sessionSilenceGapMs: (o["sessionSilenceGapMs"] as? Int) ?? AudioCaptureConfig.defaultSessionSilenceGapMs,
      maxSessionDurationMs: (o["maxSessionDurationMs"] as? Int) ?? AudioCaptureConfig.defaultMaxSessionDurationMs,
      wavRetentionTtlMs: (o["wavRetentionTtlMs"] as? Int) ?? AudioCaptureConfig.defaultWavRetentionTtlMs,
      wavMaxBytes: (o["wavMaxBytes"] as? Int) ?? AudioCaptureConfig.defaultWavMaxBytes,
      wavMaxFiles: (o["wavMaxFiles"] as? Int) ?? AudioCaptureConfig.defaultWavMaxFiles
    )
  }
}

/// playCapture 的 AVAudioPlayerDelegate —— Module 非 NSObject 不能直接 conform,
/// 用独立 NSObject helper 承接 didFinish / decodeError 回调。
private final class PlaybackDelegate: NSObject, AVAudioPlayerDelegate {
  private let onFinish: () -> Void
  private let onError: (Error?) -> Void

  init(onFinish: @escaping () -> Void, onError: @escaping (Error?) -> Void) {
    self.onFinish = onFinish
    self.onError = onError
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    onFinish()
  }

  func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
    onError(error)
  }
}

/// Capacitor call.reject(msg, code) 的 Expo 等价(AsyncFunction throw 自动 reject)。
private final class AudioCaptureException: GenericException<String> {
  override var reason: String { param }
}
