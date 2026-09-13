// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "CheshiGhosttyBridge",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .library(
      name: "CheshiGhosttyBridge",
      type: .dynamic,
      targets: ["CheshiGhosttyBridge"]
    ),
  ],
  dependencies: [
    .package(url: "https://github.com/Lakr233/libghostty-spm.git", exact: "1.3.2"),
  ],
  targets: [
    .target(
      name: "CheshiGhosttyBridge",
      dependencies: [
        .product(name: "GhosttyTerminal", package: "libghostty-spm"),
      ],
      swiftSettings: [
        .swiftLanguageMode(.v5),
      ]
    ),
  ]
)
