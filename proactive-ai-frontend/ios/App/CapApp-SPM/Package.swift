// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS("17.0")],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.3.3"),
        .package(name: "AparajitaCapacitorSecureStorage", path: "../../../../node_modules/@aparajita/capacitor-secure-storage"),
        .package(name: "CapacitorCommunityContacts", path: "../../../../node_modules/@capacitor-community/contacts"),
        .package(name: "CapacitorCommunitySqlite", path: "../../../../node_modules/@capacitor-community/sqlite"),
        .package(name: "CapacitorApp", path: "../../../../node_modules/@capacitor/app"),
        .package(name: "CapacitorBrowser", path: "../../../../node_modules/@capacitor/browser"),
        .package(name: "CapacitorDevice", path: "../../../../node_modules/@capacitor/device"),
        .package(name: "CapacitorGeolocation", path: "../../../../node_modules/@capacitor/geolocation"),
        .package(name: "CapacitorHaptics", path: "../../../../node_modules/@capacitor/haptics"),
        .package(name: "CapacitorKeyboard", path: "../../../../node_modules/@capacitor/keyboard"),
        .package(name: "CapacitorSplashScreen", path: "../../../../node_modules/@capacitor/splash-screen"),
        .package(name: "CapacitorStatusBar", path: "../../../../node_modules/@capacitor/status-bar"),
        .package(name: "CapgoCapacitorBarometer", path: "../../../../node_modules/@capgo/capacitor-barometer"),
        .package(name: "CapgoCapacitorHealth", path: "../../../../node_modules/@capgo/capacitor-health"),
        .package(name: "PinCapacitorAmbientAi", path: "../../../../capacitor-plugins/ambient-ai")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "AparajitaCapacitorSecureStorage", package: "AparajitaCapacitorSecureStorage"),
                .product(name: "CapacitorCommunityContacts", package: "CapacitorCommunityContacts"),
                .product(name: "CapacitorCommunitySqlite", package: "CapacitorCommunitySqlite"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorBrowser", package: "CapacitorBrowser"),
                .product(name: "CapacitorDevice", package: "CapacitorDevice"),
                .product(name: "CapacitorGeolocation", package: "CapacitorGeolocation"),
                .product(name: "CapacitorHaptics", package: "CapacitorHaptics"),
                .product(name: "CapacitorKeyboard", package: "CapacitorKeyboard"),
                .product(name: "CapacitorSplashScreen", package: "CapacitorSplashScreen"),
                .product(name: "CapacitorStatusBar", package: "CapacitorStatusBar"),
                .product(name: "CapgoCapacitorBarometer", package: "CapgoCapacitorBarometer"),
                .product(name: "CapgoCapacitorHealth", package: "CapgoCapacitorHealth"),
                .product(name: "PinCapacitorAmbientAi", package: "PinCapacitorAmbientAi")
            ]
        )
    ]
)
