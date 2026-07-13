import CoreBluetooth
import Foundation

struct PinHardwareDiscoveredDevice: Equatable {
    let id: UUID
    let name: String
    let rssi: Int
    let advertisedServiceUUIDs: [String]

    var isLikelyRecorder: Bool {
        let lowercasedName = name.lowercased()
        return lowercasedName.contains("mr20")
            || lowercasedName.contains("ylf20")
            || lowercasedName.contains("ylf")
            || lowercasedName.contains("edge")
            || lowercasedName.contains("recorder")
            || name.contains("音立方")
            || advertisedServiceUUIDs.contains(PinHardwareMR20Protocol.serviceUUID)
    }
}

enum PinHardwareMR20Event: Equatable {
    case battery(percent: Int)
    case firmware(version: String)
    case recording(active: Bool)
    case raw(String)
}

enum PinHardwareMR20Protocol {
    static let serviceUUID = "001120a0-2233-4455-6677-88995a5b5c5d"
    static let audioNotifyUUID = "001120a1-2233-4455-6677-88995a5b5c5d"
    static let writeUUID = "001120a2-2233-4455-6677-88995a5b5c5d"
    static let commandNotifyUUID = "001120a3-2233-4455-6677-88995a5b5c5d"

    static let statusCommand = "edge_BLE&STE"
    static let batteryCommand = "edge_BLE&BAT"
    static let firmwareCommand = "edge_BLE&FW"
    static let realtimeStartCommand = "BLE&STA"
    static let realtimeStopCommand = "BLE&STO"

    static func parseDeviceMessage(_ text: String) -> PinHardwareMR20Event {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = cleaned.split(separator: "&", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 2 else {
            return .raw(cleaned)
        }

        let prefix = parts.first ?? ""
        guard prefix == "edge_DEV" || prefix == "DEV" else {
            return .raw(cleaned)
        }

        let payload = Array(parts.dropFirst())
        if payload == ["STO"] {
            return .recording(active: false)
        }

        switch payload.first {
        case "BAT":
            if payload.count >= 2, let percent = Int(payload[1]) {
                return .battery(percent: percent)
            }
        case "FW":
            if payload.count >= 2 {
                return .firmware(version: payload[1])
            }
        case "RT", "STA":
            return .recording(active: true)
        case "STE":
            if payload.count >= 2 {
                return .recording(active: payload[1] == "1")
            }
        default:
            break
        }
        return .raw(cleaned)
    }
}
