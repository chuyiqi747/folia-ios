require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# ============================================================================
// CocoaPods 清单（仅当 ios.packageManager 为 Cocoapods 时才会被用到）
//
// Capacitor 8 默认用 SPM，此时走 Package.swift，本文件不参与构建。
// 但如果你在 capacitor.config.ts 里设了
//   ios: { packageManager: 'Cocoapods' }
// 那 CLI 会生成 Podfile 里的这一行：
//   pod 'FoliaAudioSession', :path => '...'
// 注意 pod 名是 fixName(package.name) 的结果，不是 package.name 本身，
// 所以本文件必须叫 FoliaAudioSession.podspec，spec.name 也必须是 FoliaAudioSession。
// ============================================================================

Pod::Spec.new do |s|
  s.name         = 'FoliaAudioSession'
  s.version      = package['version']
  s.summary      = package['description']
  s.license      = package['license']
  s.homepage     = 'https://github.com/chthollyphile/folia-major'
  s.author       = 'Folia iOS port'
  s.source       = { :path => '.' }
  s.source_files = 'ios/Sources/**/*.{swift,m,h}'

  s.ios.deployment_target = '15.0'
  s.swift_version = '5.9'

  s.dependency 'Capacitor'
end
