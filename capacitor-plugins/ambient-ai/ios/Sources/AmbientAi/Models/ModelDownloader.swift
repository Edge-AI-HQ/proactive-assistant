import Foundation

struct ModelDownloadSnapshot: Sendable {
    let id: String
    let state: String
    let bytesWritten: Int64
    let bytesTotal: Int64
    let errorMessage: String?
    let mirrorInUse: ModelMirror?
    let sizeOnDisk: Int64?
    let lastVerifiedAt: Double?
    let lastVerifyResult: String?
    let lastVerifyOutput: String?
    let lastVerifyError: String?

    func jsObject() -> [String: Any] {
        var dict: [String: Any] = [
            "id": id,
            "state": state,
            "bytesWritten": bytesWritten,
            "bytesTotal": bytesTotal,
        ]
        if let errorMessage { dict["errorMessage"] = errorMessage }
        if let mirrorInUse { dict["mirrorInUse"] = mirrorInUse.rawValue }
        if let sizeOnDisk { dict["sizeOnDisk"] = sizeOnDisk }
        if let lastVerifiedAt { dict["lastVerifiedAt"] = lastVerifiedAt }
        if let lastVerifyResult { dict["lastVerifyResult"] = lastVerifyResult }
        if let lastVerifyOutput { dict["lastVerifyOutput"] = lastVerifyOutput }
        if let lastVerifyError { dict["lastVerifyError"] = lastVerifyError }
        return dict
    }
}

/// Background URLSession download manager for model files.
///
/// - Default mirror order: hf-mirror → huggingface (auto failover on
///   single retry; later failures surface to the caller).
/// - Background session id is shared across all profiles so iOS can
///   coalesce work; each task is tagged with the profile id via
///   URLSessionTaskMetrics-like description-based lookup.
/// - Atomic install on success: temporary file is moved into ModelStore
///   under `<documents>/AmbientModels/<kind>/<id>.<ext>`.
actor ModelDownloader {
    typealias ProgressCallback = @Sendable (ModelDownloadSnapshot) -> Void
    typealias DoneCallback = @Sendable (ModelDownloadSnapshot) -> Void

    private struct ActiveTask {
        let id: String
        let profile: ModelProfile
        var mirror: ModelMirror
        let preferredMirror: ModelMirror
        var attemptedFallback: Bool
        var bytesWritten: Int64
        var bytesTotal: Int64
    }

    private let store: ModelStore
    private nonisolated(unsafe) var session: URLSession!
    private var tasksByIdentifier: [Int: ActiveTask] = [:]
    private var lastStatus: [String: ModelDownloadSnapshot] = [:]
    private var onProgress: ProgressCallback?
    private var onDone: DoneCallback?
    private let delegate: Delegate

    init(store: ModelStore) {
        self.store = store
        self.delegate = Delegate()
        let cfg = URLSessionConfiguration.background(withIdentifier: "pinai.ambient-ai.modeldl")
        cfg.isDiscretionary = false
        cfg.sessionSendsLaunchEvents = true
        cfg.waitsForConnectivity = true
        cfg.timeoutIntervalForResource = 60 * 60 * 4
        self.session = URLSession(configuration: cfg, delegate: delegate, delegateQueue: nil)
        Task { await self.delegate.bind(owner: self) }
    }

    func setCallbacks(progress: @escaping ProgressCallback, done: @escaping DoneCallback) {
        self.onProgress = progress
        self.onDone = done
    }

    func status(for profile: ModelProfile) async -> ModelDownloadSnapshot {
        if let cached = lastStatus[profile.id] {
            // Refresh disk state in case file was deleted out-of-band.
            let onDisk = await store.sizeOnDisk(profile)
            let present = onDisk != nil
            let nextState: String
            if cached.state == "downloading" || cached.state == "verifying" {
                nextState = cached.state
            } else if present {
                nextState = "present"
            } else if cached.state == "failed" {
                nextState = "failed"
            } else {
                nextState = "absent"
            }
            return ModelDownloadSnapshot(
                id: cached.id,
                state: nextState,
                bytesWritten: present ? (onDisk ?? cached.bytesWritten) : cached.bytesWritten,
                bytesTotal: cached.bytesTotal == 0 ? profile.approxBytes : cached.bytesTotal,
                errorMessage: nextState == "failed" ? cached.errorMessage : nil,
                mirrorInUse: cached.mirrorInUse,
                sizeOnDisk: onDisk,
                lastVerifiedAt: cached.lastVerifiedAt,
                lastVerifyResult: cached.lastVerifyResult,
                lastVerifyOutput: cached.lastVerifyOutput,
                lastVerifyError: cached.lastVerifyError
            )
        }
        let onDisk = await store.sizeOnDisk(profile)
        return ModelDownloadSnapshot(
            id: profile.id,
            state: onDisk == nil ? "absent" : "present",
            bytesWritten: onDisk ?? 0,
            bytesTotal: profile.approxBytes,
            errorMessage: nil,
            mirrorInUse: nil,
            sizeOnDisk: onDisk,
            lastVerifiedAt: nil,
            lastVerifyResult: nil,
            lastVerifyOutput: nil,
            lastVerifyError: nil
        )
    }

    func start(profile: ModelProfile, preferredMirror: ModelMirror) {
        // Refuse to start a second task for the same profile.
        if tasksByIdentifier.values.contains(where: { $0.id == profile.id }) {
            return
        }
        beginTask(profile: profile, mirror: preferredMirror, preferredMirror: preferredMirror, attemptedFallback: false)
    }

    func cancel(id: String) {
        guard let entry = tasksByIdentifier.first(where: { $0.value.id == id }) else { return }
        let identifier = entry.key
        session.getAllTasks { tasks in
            tasks.first(where: { $0.taskIdentifier == identifier })?.cancel()
        }
        tasksByIdentifier.removeValue(forKey: identifier)
        let snap = ModelDownloadSnapshot(
            id: id,
            state: "absent",
            bytesWritten: 0,
            bytesTotal: entry.value.profile.approxBytes,
            errorMessage: "cancelled",
            mirrorInUse: nil,
            sizeOnDisk: nil,
            lastVerifiedAt: nil,
            lastVerifyResult: nil,
            lastVerifyOutput: nil,
            lastVerifyError: nil
        )
        lastStatus[id] = snap
        let cb = onProgress
        if let cb { cb(snap) }
    }

    func recordVerifyResult(profileId: String, ok: Bool, output: String?, error: String?) {
        guard let cached = lastStatus[profileId] else {
            lastStatus[profileId] = ModelDownloadSnapshot(
                id: profileId,
                state: "present",
                bytesWritten: 0,
                bytesTotal: 0,
                errorMessage: nil,
                mirrorInUse: nil,
                sizeOnDisk: nil,
                lastVerifiedAt: Date().timeIntervalSince1970 * 1000.0,
                lastVerifyResult: ok ? "ok" : "fail",
                lastVerifyOutput: output,
                lastVerifyError: error
            )
            return
        }
        lastStatus[profileId] = ModelDownloadSnapshot(
            id: cached.id,
            state: cached.state,
            bytesWritten: cached.bytesWritten,
            bytesTotal: cached.bytesTotal,
            errorMessage: cached.errorMessage,
            mirrorInUse: cached.mirrorInUse,
            sizeOnDisk: cached.sizeOnDisk,
            lastVerifiedAt: Date().timeIntervalSince1970 * 1000.0,
            lastVerifyResult: ok ? "ok" : "fail",
            lastVerifyOutput: output,
            lastVerifyError: error
        )
    }

    func markVerifying(profileId: String) {
        guard let cached = lastStatus[profileId] else { return }
        lastStatus[profileId] = ModelDownloadSnapshot(
            id: cached.id,
            state: "verifying",
            bytesWritten: cached.bytesWritten,
            bytesTotal: cached.bytesTotal,
            errorMessage: nil,
            mirrorInUse: cached.mirrorInUse,
            sizeOnDisk: cached.sizeOnDisk,
            lastVerifiedAt: cached.lastVerifiedAt,
            lastVerifyResult: cached.lastVerifyResult,
            lastVerifyOutput: cached.lastVerifyOutput,
            lastVerifyError: cached.lastVerifyError
        )
    }

    func clearVerifyState(profileId: String, presentAfter: Bool) {
        let cached = lastStatus[profileId]
        let state = presentAfter ? "present" : "absent"
        lastStatus[profileId] = ModelDownloadSnapshot(
            id: profileId,
            state: state,
            bytesWritten: cached?.bytesWritten ?? 0,
            bytesTotal: cached?.bytesTotal ?? 0,
            errorMessage: nil,
            mirrorInUse: cached?.mirrorInUse,
            sizeOnDisk: cached?.sizeOnDisk,
            lastVerifiedAt: nil,
            lastVerifyResult: nil,
            lastVerifyOutput: nil,
            lastVerifyError: nil
        )
    }

    private func beginTask(profile: ModelProfile, mirror: ModelMirror, preferredMirror: ModelMirror, attemptedFallback: Bool) {
        guard let url = profile.resolvedURL(mirror: mirror) else {
            let snap = ModelDownloadSnapshot(
                id: profile.id,
                state: "failed",
                bytesWritten: 0,
                bytesTotal: profile.approxBytes,
                errorMessage: "Bad URL for profile",
                mirrorInUse: mirror,
                sizeOnDisk: nil,
                lastVerifiedAt: nil,
                lastVerifyResult: nil,
                lastVerifyOutput: nil,
                lastVerifyError: nil
            )
            lastStatus[profile.id] = snap
            onDone?(snap)
            return
        }
        let task = session.downloadTask(with: url)
        let identifier = task.taskIdentifier
        tasksByIdentifier[identifier] = ActiveTask(
            id: profile.id,
            profile: profile,
            mirror: mirror,
            preferredMirror: preferredMirror,
            attemptedFallback: attemptedFallback,
            bytesWritten: 0,
            bytesTotal: profile.approxBytes
        )
        let initial = ModelDownloadSnapshot(
            id: profile.id,
            state: "downloading",
            bytesWritten: 0,
            bytesTotal: profile.approxBytes,
            errorMessage: nil,
            mirrorInUse: mirror,
            sizeOnDisk: nil,
            lastVerifiedAt: nil,
            lastVerifyResult: nil,
            lastVerifyOutput: nil,
            lastVerifyError: nil
        )
        lastStatus[profile.id] = initial
        onProgress?(initial)
        task.resume()
    }

    fileprivate func handleProgress(taskIdentifier: Int, bytesWritten: Int64, totalBytes: Int64) {
        guard var entry = tasksByIdentifier[taskIdentifier] else { return }
        entry.bytesWritten = bytesWritten
        entry.bytesTotal = totalBytes > 0 ? totalBytes : entry.profile.approxBytes
        tasksByIdentifier[taskIdentifier] = entry
        let snap = ModelDownloadSnapshot(
            id: entry.id,
            state: "downloading",
            bytesWritten: entry.bytesWritten,
            bytesTotal: entry.bytesTotal,
            errorMessage: nil,
            mirrorInUse: entry.mirror,
            sizeOnDisk: nil,
            lastVerifiedAt: nil,
            lastVerifyResult: nil,
            lastVerifyOutput: nil,
            lastVerifyError: nil
        )
        lastStatus[entry.id] = snap
        onProgress?(snap)
    }

    fileprivate func handleFinish(taskIdentifier: Int, location: URL, response: URLResponse?) async {
        guard let entry = tasksByIdentifier[taskIdentifier] else { return }
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        tasksByIdentifier.removeValue(forKey: taskIdentifier)

        if status < 200 || status >= 300 {
            // Auto-fallback once to the alternate mirror.
            if !entry.attemptedFallback {
                let alternate: ModelMirror = entry.mirror == .hfMirror ? .hf : .hfMirror
                beginTask(profile: entry.profile, mirror: alternate, preferredMirror: entry.preferredMirror, attemptedFallback: true)
                return
            }
            let snap = ModelDownloadSnapshot(
                id: entry.id,
                state: "failed",
                bytesWritten: entry.bytesWritten,
                bytesTotal: entry.bytesTotal,
                errorMessage: "HTTP \(status)",
                mirrorInUse: entry.mirror,
                sizeOnDisk: nil,
                lastVerifiedAt: nil,
                lastVerifyResult: nil,
                lastVerifyOutput: nil,
                lastVerifyError: nil
            )
            lastStatus[entry.id] = snap
            onDone?(snap)
            return
        }

        // The delegate already moved iOS's temp file into a stable
        // staging path before bouncing back into the actor, so we can
        // install directly from `location`.
        do {
            try await store.install(from: location, profile: entry.profile)
        } catch {
            try? FileManager.default.removeItem(at: location)
            let snap = ModelDownloadSnapshot(
                id: entry.id,
                state: "failed",
                bytesWritten: entry.bytesWritten,
                bytesTotal: entry.bytesTotal,
                errorMessage: "Install failed: \(error.localizedDescription)",
                mirrorInUse: entry.mirror,
                sizeOnDisk: nil,
                lastVerifiedAt: nil,
                lastVerifyResult: nil,
                lastVerifyOutput: nil,
                lastVerifyError: nil
            )
            lastStatus[entry.id] = snap
            onDone?(snap)
            return
        }

        let onDisk = await store.sizeOnDisk(entry.profile)
        let magicOk = await store.headerMagicMatches(entry.profile)
        if !magicOk {
            await store.remove(entry.profile)
            let snap = ModelDownloadSnapshot(
                id: entry.id,
                state: "failed",
                bytesWritten: entry.bytesWritten,
                bytesTotal: entry.bytesTotal,
                errorMessage: "Magic header mismatch: file is not a \(entry.profile.magic.rawValue) blob",
                mirrorInUse: entry.mirror,
                sizeOnDisk: nil,
                lastVerifiedAt: nil,
                lastVerifyResult: nil,
                lastVerifyOutput: nil,
                lastVerifyError: nil
            )
            lastStatus[entry.id] = snap
            onDone?(snap)
            return
        }

        let snap = ModelDownloadSnapshot(
            id: entry.id,
            state: "present",
            bytesWritten: onDisk ?? entry.bytesWritten,
            bytesTotal: entry.bytesTotal,
            errorMessage: nil,
            mirrorInUse: entry.mirror,
            sizeOnDisk: onDisk,
            lastVerifiedAt: nil,
            lastVerifyResult: nil,
            lastVerifyOutput: nil,
            lastVerifyError: nil
        )
        lastStatus[entry.id] = snap
        onDone?(snap)
    }

    fileprivate func handleError(taskIdentifier: Int, error: Error) async {
        guard let entry = tasksByIdentifier[taskIdentifier] else { return }
        tasksByIdentifier.removeValue(forKey: taskIdentifier)
        let nsError = error as NSError
        // Auto-fallback once on network errors before surfacing failure.
        if !entry.attemptedFallback,
           nsError.domain == NSURLErrorDomain,
           nsError.code != NSURLErrorCancelled {
            let alternate: ModelMirror = entry.mirror == .hfMirror ? .hf : .hfMirror
            beginTask(profile: entry.profile, mirror: alternate, preferredMirror: entry.preferredMirror, attemptedFallback: true)
            return
        }
        let snap = ModelDownloadSnapshot(
            id: entry.id,
            state: nsError.code == NSURLErrorCancelled ? "absent" : "failed",
            bytesWritten: entry.bytesWritten,
            bytesTotal: entry.bytesTotal,
            errorMessage: error.localizedDescription,
            mirrorInUse: entry.mirror,
            sizeOnDisk: nil,
            lastVerifiedAt: nil,
            lastVerifyResult: nil,
            lastVerifyOutput: nil,
            lastVerifyError: nil
        )
        lastStatus[entry.id] = snap
        onDone?(snap)
    }
}

// MARK: - Delegate

extension ModelDownloader {
    final class Delegate: NSObject, URLSessionDownloadDelegate {
        private weak var owner: ModelDownloader?

        fileprivate func bind(owner: ModelDownloader) {
            self.owner = owner
        }

        func urlSession(_ session: URLSession,
                        downloadTask: URLSessionDownloadTask,
                        didWriteData bytesWritten: Int64,
                        totalBytesWritten: Int64,
                        totalBytesExpectedToWrite: Int64) {
            let identifier = downloadTask.taskIdentifier
            let written = totalBytesWritten
            let total = totalBytesExpectedToWrite
            Task { [weak owner] in
                await owner?.handleProgress(taskIdentifier: identifier, bytesWritten: written, totalBytes: total)
            }
        }

        func urlSession(_ session: URLSession,
                        downloadTask: URLSessionDownloadTask,
                        didFinishDownloadingTo location: URL) {
            // The temp file is reaped right after this method returns.
            // Move it synchronously to a staging path before bouncing
            // back into the actor.
            let staging = FileManager.default.temporaryDirectory
                .appendingPathComponent("ambient-model-staging-\(UUID().uuidString)")
            do {
                try? FileManager.default.removeItem(at: staging)
                try FileManager.default.moveItem(at: location, to: staging)
            } catch {
                Task { [weak owner] in
                    await owner?.handleError(taskIdentifier: downloadTask.taskIdentifier, error: error)
                }
                return
            }
            let response = downloadTask.response
            let identifier = downloadTask.taskIdentifier
            Task { [weak owner] in
                await owner?.handleFinish(taskIdentifier: identifier, location: staging, response: response)
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            guard let error else { return }
            let identifier = task.taskIdentifier
            Task { [weak owner] in
                await owner?.handleError(taskIdentifier: identifier, error: error)
            }
        }
    }
}
