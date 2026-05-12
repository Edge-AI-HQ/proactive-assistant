import Foundation

struct CollectionCadenceGate {
    let minimumInterval: TimeInterval
    private var lastRunAt: Date?

    init(minimumInterval: TimeInterval) {
        self.minimumInterval = max(0, minimumInterval)
    }

    mutating func shouldRun(now: Date = Date()) -> Bool {
        guard let lastRunAt else {
            self.lastRunAt = now
            return true
        }
        guard now.timeIntervalSince(lastRunAt) >= minimumInterval else {
            return false
        }
        self.lastRunAt = now
        return true
    }

    mutating func reset() {
        lastRunAt = nil
    }
}
