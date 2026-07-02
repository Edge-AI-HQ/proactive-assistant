import Foundation

actor ModelStore {
    private let rootDirectory: URL
    private let fm = FileManager.default

    init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        rootDirectory = docs.appendingPathComponent("AmbientModels", isDirectory: true)
    }

    private func ensureKindDirectory(_ kind: ModelKind) {
        let dir = rootDirectory.appendingPathComponent(kind.rawValue, isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    func fileURL(for profile: ModelProfile) -> URL {
        ensureKindDirectory(profile.kind)
        let ext = profile.fileExtension.isEmpty ? "bin" : profile.fileExtension
        return rootDirectory
            .appendingPathComponent(profile.kind.rawValue, isDirectory: true)
            .appendingPathComponent("\(profile.id).\(ext)")
    }

    func isPresent(_ profile: ModelProfile) -> Bool {
        fm.fileExists(atPath: fileURL(for: profile).path)
    }

    func sizeOnDisk(_ profile: ModelProfile) -> Int64? {
        let url = fileURL(for: profile)
        guard fm.fileExists(atPath: url.path) else { return nil }
        guard let attrs = try? fm.attributesOfItem(atPath: url.path) else { return nil }
        return (attrs[.size] as? NSNumber)?.int64Value
    }

    @discardableResult
    func remove(_ profile: ModelProfile) -> Bool {
        let url = fileURL(for: profile)
        guard fm.fileExists(atPath: url.path) else { return false }
        do {
            try fm.removeItem(at: url)
            return true
        } catch {
            return false
        }
    }

    /// Atomic install: replace any existing file and verify the first 4
    /// bytes match the profile's magic.
    func install(from tempURL: URL, profile: ModelProfile) throws {
        ensureKindDirectory(profile.kind)
        let dest = fileURL(for: profile)
        if fm.fileExists(atPath: dest.path) {
            try fm.removeItem(at: dest)
        }
        try fm.moveItem(at: tempURL, to: dest)
    }

    func headerMagicMatches(_ profile: ModelProfile) -> Bool {
        let url = fileURL(for: profile)
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: profile.magic.headerBytes.count) else {
            return false
        }
        return Array(data) == profile.magic.headerBytes
    }

    func availableDiskBytes() -> Int64? {
        let url = rootDirectory
        try? fm.createDirectory(at: url, withIntermediateDirectories: true)
        guard let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]) else {
            return nil
        }
        return values.volumeAvailableCapacityForImportantUsage
    }
}
