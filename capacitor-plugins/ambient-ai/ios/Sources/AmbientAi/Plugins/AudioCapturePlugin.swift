import AVFoundation
@preconcurrency import Capacitor
import Foundation
import UIKit

@objc(AudioCapturePlugin)
public class AudioCapturePlugin: CAPPlugin, CAPBridgedPlugin, AVAudioPlayerDelegate {
    public let identifier = "AudioCapturePlugin"
    public let jsName = "AudioCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drainPendingTranscripts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listRecentCaptures", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "markCaptureProcessed", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopPlayback", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startClassification", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopClassification", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setExternalMicSuppressed", returnType: CAPPluginReturnPromise),
    ]

    private lazy var audioManager = AudioStreamManager(callbacks: .init(
        emitEvent: { [weak self] eventName, payload in
            DispatchQueue.main.async {
                self?.notifyListeners(eventName, data: payload)
            }
        }
    ))
    private var playbackPlayer: AVAudioPlayer?
    private var appActiveObserver: NSObjectProtocol?
    private var appWillResignActiveObserver: NSObjectProtocol?
    private var appDidEnterBackgroundObserver: NSObjectProtocol?

    public override func load() {
        appActiveObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task {
                await self?.audioManager.setAppBackgrounded(false, reason: "appDidBecomeActive")
                await self?.audioManager.recoverClassifierIfNeeded(reason: "appDidBecomeActive")
            }
        }
        appWillResignActiveObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { await self?.audioManager.setAppBackgrounded(true, reason: "appWillResignActive") }
        }
        appDidEnterBackgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { await self?.audioManager.setAppBackgrounded(true, reason: "appDidEnterBackground") }
        }
    }

    deinit {
        if let appActiveObserver {
            NotificationCenter.default.removeObserver(appActiveObserver)
        }
        if let appWillResignActiveObserver {
            NotificationCenter.default.removeObserver(appWillResignActiveObserver)
        }
        if let appDidEnterBackgroundObserver {
            NotificationCenter.default.removeObserver(appDidEnterBackgroundObserver)
        }
    }

    // MARK: - Permissions

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        switch AVAudioApplication.shared.recordPermission {
        case .granted, .denied:
            resolveAudioPermissions(call)
        case .undetermined:
            AVAudioApplication.requestRecordPermission { granted in
                call.resolve([
                    "microphone": granted ? "granted" : "denied",
                    "speechRecognition": self.speechPermissionState(),
                ])
            }
        @unknown default:
            call.resolve([
                "microphone": "prompt",
                "speechRecognition": speechPermissionState(),
            ])
        }
    }

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        call.resolve([
            "microphone": microphonePermissionState(),
            "speechRecognition": speechPermissionState(),
        ])
    }

    // MARK: - Configuration

    @objc func configure(_ call: CAPPluginCall) {
        let config = audioCaptureConfig(from: call)
        Task { [weak self] in
            await self?.audioManager.configure(config)
            DispatchQueue.main.async {
                call.resolve()
            }
        }
    }

    // MARK: - Capture

    @objc func startCapture(_ call: CAPPluginCall) {
        guard microphonePermissionState() == "granted" else {
            call.reject("Microphone permission not granted", "PERMISSION_DENIED")
            return
        }

        Task { [weak self] in
            do {
                try await self?.audioManager.startCapture()
                DispatchQueue.main.async { call.resolve() }
            } catch {
                self?.notifyAudioError(error.localizedDescription, source: "capture")
                DispatchQueue.main.async {
                    call.reject(error.localizedDescription, "AUDIO_CAPTURE_START_FAILED")
                }
            }
        }
    }

    @objc func stopCapture(_ call: CAPPluginCall) {
        Task { [weak self] in
            await self?.audioManager.stopCapture()
            DispatchQueue.main.async { call.resolve() }
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        Task { [weak self] in
            let payload = await self?.audioManager.snapshot().payload ?? [
                "running": false,
                "paused": false,
                "capturing": false,
                "classificationRunning": false,
                "engineRunning": false,
                "capturePipelineRunning": false,
                "engineState": AudioEngineState.stopped.rawValue,
                "classifierRestartCount": 0,
                "suppressed": false,
            ]
            DispatchQueue.main.async {
                call.resolve(payload)
            }
        }
    }

    @objc func drainPendingTranscripts(_ call: CAPPluginCall) {
        Task { [weak self] in
            let transcripts = await self?.audioManager.drainPendingTranscripts() ?? []
            DispatchQueue.main.async {
                call.resolve(["transcripts": transcripts])
            }
        }
    }

    @objc func listRecentCaptures(_ call: CAPPluginCall) {
        Task { [weak self] in
            let captures = await self?.audioManager.listRecentCaptures() ?? []
            DispatchQueue.main.async {
                call.resolve(["captures": captures])
            }
        }
    }

    @objc func readCapture(_ call: CAPPluginCall) {
        guard let wavId = call.getString("wavId"), !wavId.isEmpty else {
            call.reject(AudioCaptureFailure.missingWavId.localizedDescription, "MISSING_WAV_ID")
            return
        }

        Task { [weak self] in
            guard let self else { return }
            guard let url = await self.audioManager.captureURL(wavId: wavId) else {
                DispatchQueue.main.async {
                    call.reject(AudioCaptureFailure.wavNotFound.localizedDescription, "WAV_NOT_FOUND")
                }
                return
            }
            do {
                let data = try Data(contentsOf: url)
                DispatchQueue.main.async {
                    call.resolve([
                        "wavId": wavId,
                        "contentType": "audio/wav",
                        "base64": data.base64EncodedString(),
                        "byteSize": data.count,
                    ])
                }
            } catch {
                self.notifyAudioError(error.localizedDescription, source: "capture")
                DispatchQueue.main.async {
                    call.reject(error.localizedDescription, "READ_CAPTURE_FAILED")
                }
            }
        }
    }

    @objc func markCaptureProcessed(_ call: CAPPluginCall) {
        guard let wavId = call.getString("wavId"), !wavId.isEmpty else {
            call.reject(AudioCaptureFailure.missingWavId.localizedDescription, "MISSING_WAV_ID")
            return
        }

        Task { [weak self] in
            await self?.audioManager.markCaptureProcessed(wavId: wavId)
            DispatchQueue.main.async { call.resolve() }
        }
    }

    @objc func playCapture(_ call: CAPPluginCall) {
        guard let wavId = call.getString("wavId"), !wavId.isEmpty else {
            call.reject(AudioCaptureFailure.missingWavId.localizedDescription, "MISSING_WAV_ID")
            return
        }

        Task { [weak self] in
            guard let self else { return }
            guard let url = await self.audioManager.captureURL(wavId: wavId) else {
                DispatchQueue.main.async {
                    call.reject(AudioCaptureFailure.wavNotFound.localizedDescription, "WAV_NOT_FOUND")
                }
                return
            }

            // Suppression flips shouldClassifierRun off via the audio
            // manager's reconcile path, which tears down the SoundAnalysis
            // engine and deactivates the session — but leaves the
            // isCaptureRunning / isClassificationRunning desired state
            // untouched so resumption is automatic on un-suppress.
            await self.audioManager.setPlaybackSuppressed(true)

            let session = AVAudioSession.sharedInstance()
            do {
                try session.setCategory(.playback, mode: .default, options: [])
                try session.setActive(true, options: [])
            } catch {
                self.notifyAudioError(error.localizedDescription, source: "playback")
                await self.restoreAfterPlayback()
                DispatchQueue.main.async {
                    call.reject(error.localizedDescription, "PLAYBACK_SESSION_FAILED")
                }
                return
            }

            DispatchQueue.main.async {
                do {
                    self.playbackPlayer?.stop()
                    let player = try AVAudioPlayer(contentsOf: url)
                    player.delegate = self
                    self.playbackPlayer = player
                    player.prepareToPlay()
                    player.play()
                    call.resolve()
                } catch {
                    Task { await self.restoreAfterPlayback() }
                    self.notifyAudioError(error.localizedDescription, source: "playback")
                    call.reject(error.localizedDescription, "PLAYBACK_FAILED")
                }
            }
        }
    }

    @objc func stopPlayback(_ call: CAPPluginCall) {
        playbackPlayer?.stop()
        playbackPlayer = nil
        Task { [weak self] in
            await self?.restoreAfterPlayback()
            DispatchQueue.main.async { call.resolve() }
        }
    }

    private func restoreAfterPlayback() async {
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        // Un-suppressing reconciles classifier state: the audio manager
        // restarts the SoundAnalysis engine with .playAndRecord/.measurement
        // when isCaptureRunning or isClassificationRunning was still true.
        await audioManager.setPlaybackSuppressed(false)
    }

    // MARK: - Sound classification skeleton

    @objc func startClassification(_ call: CAPPluginCall) {
        guard microphonePermissionState() == "granted" else {
            call.reject("Microphone permission not granted", "PERMISSION_DENIED")
            return
        }
        Task { [weak self] in
            do {
                try await self?.audioManager.startClassification()
                DispatchQueue.main.async { call.resolve() }
            } catch {
                self?.notifyAudioError(error.localizedDescription, source: "soundAnalysis")
                DispatchQueue.main.async {
                    call.reject(error.localizedDescription, "CLASSIFICATION_START_FAILED")
                }
            }
        }
    }

    @objc func stopClassification(_ call: CAPPluginCall) {
        Task { [weak self] in
            await self?.audioManager.stopClassification()
            DispatchQueue.main.async { call.resolve() }
        }
    }

    @objc func setExternalMicSuppressed(_ call: CAPPluginCall) {
        let suppressed = call.getBool("suppressed") ?? false
        Task { [weak self] in
            await self?.audioManager.setExternalMicSuppressed(suppressed)
            DispatchQueue.main.async { call.resolve() }
        }
    }

    // MARK: - Private

    private func resolveAudioPermissions(_ call: CAPPluginCall) {
        call.resolve([
            "microphone": microphonePermissionState(),
            "speechRecognition": speechPermissionState(),
        ])
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
        // Local SFSpeech transcription is dormant; do not touch Speech APIs on
        // the ambient startup path.
        return "prompt"
    }

    private func notifyAudioError(_ message: String, source: String) {
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners("audioError", data: [
                "message": message,
                "source": source,
            ])
        }
    }

    private func audioCaptureConfig(from call: CAPPluginCall) -> AudioCaptureConfig {
        let cloudMode = call.getString("cloudMode")
            .flatMap(AudioCloudMode.init(rawValue:)) ?? .off
        let baseURL = call.getString("cloudBaseURL")
            .flatMap { value -> URL? in
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : URL(string: trimmed)
            }

        return AudioCaptureConfig(
            cloudMode: cloudMode,
            recognitionLocale: call.getString("recognitionLocale"),
            cloudApiKey: call.getString("cloudApiKey"),
            cloudBaseURL: baseURL,
            modelName: call.getString("modelName") ?? AudioCaptureConfig.defaultModelName,
            cloudRefineTimeoutMs: call.getInt("cloudRefineTimeoutMs") ?? AudioCaptureConfig.defaultCloudRefineTimeoutMs,
            preRollMs: call.getInt("preRollMs") ?? AudioCaptureConfig.defaultPreRollMs,
            postRollMs: call.getInt("postRollMs") ?? AudioCaptureConfig.defaultPostRollMs,
            maxBurstMs: call.getInt("maxBurstMs") ?? AudioCaptureConfig.defaultMaxBurstMs,
            minBurstMs: call.getInt("minBurstMs") ?? AudioCaptureConfig.defaultMinBurstMs,
            sessionSilenceGapMs: call.getInt("sessionSilenceGapMs") ?? AudioCaptureConfig.defaultSessionSilenceGapMs,
            maxSessionDurationMs: call.getInt("maxSessionDurationMs") ?? AudioCaptureConfig.defaultMaxSessionDurationMs,
            wavRetentionTtlMs: call.getInt("wavRetentionTtlMs") ?? AudioCaptureConfig.defaultWavRetentionTtlMs,
            wavMaxBytes: call.getInt("wavMaxBytes") ?? AudioCaptureConfig.defaultWavMaxBytes,
            wavMaxFiles: call.getInt("wavMaxFiles") ?? AudioCaptureConfig.defaultWavMaxFiles
        )
    }

    // MARK: - AVAudioPlayerDelegate

    public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        playbackPlayer = nil
        Task { [weak self] in
            await self?.restoreAfterPlayback()
        }
    }

    public func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        playbackPlayer = nil
        if let error {
            notifyAudioError(error.localizedDescription, source: "playback")
        }
        Task { [weak self] in
            await self?.restoreAfterPlayback()
        }
    }
}

extension AudioCapturePlugin: @unchecked Sendable {}
