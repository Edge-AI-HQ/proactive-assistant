import AppIntents
import Capacitor
import UIKit

private enum PINShortcutRoute {
    static func dispatch(_ action: String) {
        guard
            let scheme = Bundle.main.bundleIdentifier,
            let url = URL(string: "\(scheme)://shortcut/\(action)")
        else {
            return
        }
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            open: url,
            options: [:]
        )
    }
}

struct TogglePINAIIntent: AppIntent {
    static let title: LocalizedStringResource = "Toggle PIN AI"
    static let description = IntentDescription("Start or stop PIN AI Ambient.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        PINShortcutRoute.dispatch("toggle-ambient")
        return .result(dialog: "PIN AI is toggling Ambient.")
    }
}

struct GeneratePINCardsIntent: AppIntent {
    static let title: LocalizedStringResource = "Generate PIN Cards"
    static let description = IntentDescription("Trigger a new PIN AI card generation run.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        PINShortcutRoute.dispatch("generate-cards")
        return .result(dialog: "PIN AI is generating cards.")
    }
}

struct PINAIShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TogglePINAIIntent(),
            phrases: [
                "Toggle \(.applicationName)",
                "Start \(.applicationName)",
                "Stop \(.applicationName)",
            ],
            shortTitle: "Toggle PIN AI",
            systemImageName: "sparkles"
        )
        AppShortcut(
            intent: GeneratePINCardsIntent(),
            phrases: [
                "Generate cards in \(.applicationName)",
                "Generate \(.applicationName) cards",
            ],
            shortTitle: "Generate Cards",
            systemImageName: "rectangle.stack.badge.plus"
        )
    }
}
