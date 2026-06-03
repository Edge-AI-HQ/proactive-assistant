import Foundation

/// Slices a stream of variable-size Float sample arrays into fixed-size
/// chunks. Split out from `SileroVadGate` so the buffering logic is unit
/// testable without pulling in `VadManager` (which needs the CoreML model
/// file at runtime).
///
/// Not thread-safe: callers must serialize their `append` / `drain` calls
/// (`SileroVadGate` does so on its `workQueue`).
struct SileroChunkBuffer {
    let chunkSize: Int
    private var pending: [Float] = []

    init(chunkSize: Int) {
        precondition(chunkSize > 0, "chunkSize must be positive")
        self.chunkSize = chunkSize
    }

    var pendingSampleCount: Int { pending.count }

    /// Append samples and return any newly-completed chunks in order.
    /// Leftover (< chunkSize) samples stay in the buffer until the next call.
    mutating func append(_ samples: [Float]) -> [[Float]] {
        guard !samples.isEmpty else { return [] }
        pending.append(contentsOf: samples)
        var output: [[Float]] = []
        while pending.count >= chunkSize {
            output.append(Array(pending.prefix(chunkSize)))
            pending.removeFirst(chunkSize)
        }
        return output
    }

    /// Discard any buffered partial chunk. Used when the gate stops so a
    /// later restart begins with a clean alignment.
    mutating func reset() {
        pending.removeAll(keepingCapacity: true)
    }
}
