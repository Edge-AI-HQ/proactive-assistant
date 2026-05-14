@preconcurrency import Capacitor
import Foundation

@objc(AmbientModelsPlugin)
public class AmbientModelsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AmbientModelsPlugin"
    public let jsName = "AmbientModels"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "listModels", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startModelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelModelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "verifyModel", returnType: CAPPluginReturnPromise),
    ]

    private let store = ModelStore()
    private lazy var downloader = ModelDownloader(store: store)
    private let verifyEngine: ModelVerifyEngine = makeVerifyEngine()
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

    private func emit(_ snap: ModelDownloadSnapshot, event: String) {
        var payload = snap.jsObject()
        payload["emittedAt"] = Date().timeIntervalSince1970 * 1000.0
        DispatchQueue.main.async {
            self.notifyListeners(event, data: payload)
        }
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
