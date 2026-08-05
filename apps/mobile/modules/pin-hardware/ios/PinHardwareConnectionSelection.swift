import Foundation

enum PinHardwareConnectionSelectionAction: Equatable {
    case connect
    case restart
    case replace
}

func pinHardwareConnectionSelectionAction(
    selectedId: UUID,
    activeId: UUID?,
    activeIsConnecting: Bool
) -> PinHardwareConnectionSelectionAction {
    guard let activeId else { return .connect }
    guard activeId == selectedId else { return .replace }
    return activeIsConnecting ? .restart : .connect
}
