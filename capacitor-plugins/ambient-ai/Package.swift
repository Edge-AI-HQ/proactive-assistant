// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PinCapacitorAmbientAi",
    platforms: [.iOS(.v17)],
    products: [
        .library(
            name: "PinCapacitorAmbientAi",
            targets: ["AmbientAi"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/mattt/llama.swift.git", exact: "2.8934.0"),
    ],
    targets: [
        .target(
            name: "AmbientAi",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "LlamaSwift", package: "llama.swift"),
            ],
            path: "ios/Sources/AmbientAi"),
        .testTarget(
            name: "AmbientAiTests",
            dependencies: ["AmbientAi"],
            path: "ios/Tests/AmbientAiTests")
    ]
)
