// swift-tools-version: 5.9

import PackageDescription

// ============================================================================
// 本地 SwiftPM 清单
//
// ⚠️ 两个 name 都必须叫 FoliaAudioSession，不能改。
//
// Capacitor CLI 在 SPM 模式下会这样处理本地插件（见 cli/src/util/spm.ts）：
//   1. 用插件 package.json 的 name（folia-audio-session）算出 fixName：
//        folia-audio-session -> folia_audio_session -> foliaAudioSession
//        -> 首字母大写 -> FoliaAudioSession
//      这个结果就是 CLI 眼中的 plugin.ios.name。
//   2. 在 ios/App/CapApp-SPM/Package.swift 里写入：
//        .package(name: "FoliaAudioSession", path: "../../node_modules/folia-audio-session")
//        .product(name: "FoliaAudioSession", package: "FoliaAudioSession")
//   3. 上面这行 .package(name:) 要求本文件的 package name 必须一致，
//      .product(name:) 要求 products 里必须导出同名 library。
//   任何一个对不上，Xcode 会报
//      "Unknown package 'FoliaAudioSession' in dependencies of target 'CapApp-SPM'"
//
// platforms 必须 >= Capacitor 8 的最低要求（iOS 15）。
// ============================================================================

let package = Package(
    name: "FoliaAudioSession",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "FoliaAudioSession",
            targets: ["FoliaAudioSession"])
    ],
    dependencies: [
        // 必须与 @capacitor/ios 主版本一致，否则会链接进两份 Capacitor 符号
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "FoliaAudioSession",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/FoliaAudioSession")
    ]
)
