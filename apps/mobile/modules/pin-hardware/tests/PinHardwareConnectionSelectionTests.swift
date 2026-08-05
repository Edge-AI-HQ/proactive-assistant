import Foundation

@main
enum PinHardwareConnectionSelectionTests {
    static func main() throws {
        let selectedId = UUID()

        try expect(
            pinHardwareConnectionSelectionAction(
                selectedId: selectedId,
                activeId: nil,
                activeIsConnecting: false
            ) == .connect,
            "a selection without an active peripheral should connect"
        )
        try expect(
            pinHardwareConnectionSelectionAction(
                selectedId: selectedId,
                activeId: selectedId,
                activeIsConnecting: true
            ) == .restart,
            "a repeated selection should restart a stuck connection"
        )
        try expect(
            pinHardwareConnectionSelectionAction(
                selectedId: selectedId,
                activeId: UUID(),
                activeIsConnecting: true
            ) == .replace,
            "an explicit selection should replace a stale active peripheral"
        )
        try expect(
            pinHardwareConnectionSelectionAction(
                selectedId: selectedId,
                activeId: UUID(),
                activeIsConnecting: false
            ) == .replace,
            "a disconnected active object must not block the selected peripheral"
        )

        print("PinHardwareConnectionSelectionTests passed")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else {
            throw NSError(
                domain: "PinHardwareConnectionSelectionTests",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: message]
            )
        }
    }
}
