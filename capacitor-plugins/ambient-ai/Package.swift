// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PinCapacitorAmbientAi",
    // macOS is here only so `swift build` / `swift test` on a Mac can
    // resolve the FluidAudio dep (it requires macOS 14+); the plugin itself
    // ships to iOS only via Capacitor.
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(
            name: "PinCapacitorAmbientAi",
            targets: ["AmbientAi"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/mattt/llama.swift.git", exact: "2.8934.0"),
        // Silero VAD v5 via FluidInference's CoreML-converted package.
        // Runs on the Apple Neural Engine, MIT/Apache licensed, the de
        // facto open-source VAD used by OpenAI Realtime, LiveKit Agents,
        // Pipecat, and Whisper.cpp examples. Replaces our prior
        // SoundAnalysis-"speech"-label trigger which was misclassifying
        // keyboard / HVAC / background voices as user speech.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.14.8"),
    ],
    targets: [
        .target(
            name: "AmbientAi",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "LlamaSwift", package: "llama.swift"),
                .product(name: "FluidAudio", package: "FluidAudio"),
            ],
            path: "ios/Sources/AmbientAi"),
        .testTarget(
            name: "AmbientAiTests",
            dependencies: ["AmbientAi"],
            path: "ios/Tests/AmbientAiTests")
    ]
)
