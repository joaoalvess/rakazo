// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "rakazo-displayd",
  platforms: [.macOS(.v14)],
  targets: [
    .target(name: "CGVirtualDisplayPrivate"),
    .target(name: "DisplaydCore"),
    .executableTarget(name: "rakazo-displayd", dependencies: ["CGVirtualDisplayPrivate", "DisplaydCore"]),
    .testTarget(name: "DisplaydCoreTests", dependencies: ["DisplaydCore"]),
  ]
)
