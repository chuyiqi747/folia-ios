#!/usr/bin/env bash
# ============================================================================
# build-ios-unsigned.sh
#
# 编译出**未签名**的 IPA。CI 和本地 Mac 走同一条路径，避免两处维护。
#
# 产物：<仓库根>/build/Folia-unsigned.ipa
#
# ⚠️ 只能在 macOS 上运行。
#
# 用法：
#   bash scripts/build-ios-unsigned.sh
#
# 前置：已执行过 npx cap sync ios 与 bash scripts/apply-ios-plist.sh
# ============================================================================

set -euo pipefail

PROJECT_DIR="ios/App"
OUT_DIR="build"
APP_NAME="App"
IPA_NAME="Folia-unsigned.ipa"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "✗ 找不到 xcodebuild —— 本脚本只能在 macOS 上运行。" >&2
  echo "  Windows 上请改用 GitHub Actions：见 docs/Windows出包指南.md" >&2
  exit 1
fi

if [ ! -f "$PROJECT_DIR/App.xcodeproj/project.pbxproj" ]; then
  echo "✗ 找不到 $PROJECT_DIR/App.xcodeproj" >&2
  echo "  先执行：npx cap add ios && npx cap sync ios" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 为什么是 -project 而不是 -workspace
#
# Capacitor 8 默认用 SPM，CLI 的 removeCocoapodsFiles() 会删掉 App.xcworkspace。
# 网上大量教程写的 -workspace 在 Capacitor 8 上会直接报文件不存在。
# ---------------------------------------------------------------------------
if [ -e "$PROJECT_DIR/App.xcworkspace" ]; then
  echo "⚠️  检测到 App.xcworkspace（CocoaPods 模式）"
  echo "    本脚本按 SPM 模式用 -project 构建。若你确实在用 CocoaPods，"
  echo "    请把下面的 -project 换成 -workspace 并补上 -scheme。"
fi

# ---------------------------------------------------------------------------
# 为什么是 -target 而不是 -scheme
#
# Capacitor 的 iOS 模板不含共享 scheme（xcshareddata/xcschemes/ 为空）。
# scheme 是 Xcode 打开工程时才自动生成、存在 xcuserdata 里的，CI 上没有这一步，
# 所以 -scheme App 会报 scheme not found。
# ---------------------------------------------------------------------------
echo "==> 编译（关闭签名）"
cd "$PROJECT_DIR"
xcodebuild \
  -project App.xcodeproj \
  -target "$APP_NAME" \
  -configuration Release \
  -sdk iphoneos \
  -derivedDataPath "../../$OUT_DIR" \
  -clonedSourcePackagesDirPath "../../$OUT_DIR/spm" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGNING_ENTITLEMENTS="" \
  build

cd - >/dev/null

# ---------------------------------------------------------------------------
# 打包。不用 xcodebuild -exportArchive —— 那是为「带签名的分发」设计的，
# 在完全没有签名身份时会失败。未签名 IPA 的标准结构就是一个 zip：
#     <名字>.ipa
#     └── Payload/
#         └── App.app/
# ---------------------------------------------------------------------------
APP_PATH=$(find "$OUT_DIR/Build/Products/Release-iphoneos" -maxdepth 1 -name '*.app' | head -1)

if [ -z "$APP_PATH" ]; then
  echo "✗ 没找到编译产物 .app" >&2
  ls -R "$OUT_DIR/Build/Products" 2>/dev/null | head -50 >&2 || true
  exit 1
fi
echo "==> 编译产物：$APP_PATH"

rm -rf "$OUT_DIR/Payload"
mkdir -p "$OUT_DIR/Payload"
cp -R "$APP_PATH" "$OUT_DIR/Payload/"

# 未签名包不该有任何签名残留，否则 Sideloadly 可能拒绝重签
rm -rf "$OUT_DIR/Payload/$APP_NAME.app/_CodeSignature"
rm -f "$OUT_DIR/Payload/$APP_NAME.app/embedded.mobileprovision"

# ---------------------------------------------------------------------------
# 可选：ad-hoc 签名（TrollStore 兼容性保险）
#
#   FOLIA_ADHOC_SIGN=1 bash scripts/build-ios-unsigned.sh
#
# 什么时候需要它：
#   TrollStore 官方 README 说它能装「any IPA」，并且安装时会用自己的假根证书
#   重新签名（依赖 AMFI/CoreTrust 对「多个签名者」的校验缺陷）。
#   理论上完全未签名的 IPA 可以直接装。
#
#   但社区里偶有报告安装时报 "Unsigned App" —— 通常出现在二进制里
#   连签名槽位（LC_CODE_SIGNATURE）都不存在的情况，TrollStore 无法替换签名。
#   加一个 ad-hoc 签名（codesign -s -）会让二进制里有合法的签名结构，
#   TrollStore 就能把它替换成自己的假证书。
#
# 对 Sideloadly 有影响吗：
#   没有。Sideloadly 会先剥离原有签名再重签，所以加了也不影响那条路。
#
# 默认关闭，因为「未签名 IPA」是更通用的产物格式。
# ---------------------------------------------------------------------------
if [ "${FOLIA_ADHOC_SIGN:-0}" = "1" ]; then
  echo "==> ad-hoc 签名（TrollStore 兼容性保险）"
  codesign --force --sign - "$OUT_DIR/Payload/$APP_NAME.app"

  # 嵌套的 framework / dylib 也要签，否则签名不完整
  find "$OUT_DIR/Payload/$APP_NAME.app" \
    \( -name '*.framework' -o -name '*.dylib' \) -print0 2>/dev/null |
    while IFS= read -r -d '' item; do
      codesign --force --sign - "$item" 2>/dev/null || true
    done

  if codesign --verify --deep "$OUT_DIR/Payload/$APP_NAME.app" 2>/dev/null; then
    echo "    ad-hoc 签名校验通过"
  else
    echo "    ⚠️  签名校验未通过（可能不影响 TrollStore 安装，但值得留意）"
  fi
fi

cd "$OUT_DIR"
rm -f "$IPA_NAME"
zip -qry "$IPA_NAME" Payload
cd - >/dev/null

echo "==> 打包完成：$OUT_DIR/$IPA_NAME（$(du -h "$OUT_DIR/$IPA_NAME" | cut -f1)）"
echo ""
echo "下一步（在你的 Windows 上）："
echo "  1. 下载这个 IPA"
echo "  2. 用 Sideloadly 打开，填入免费 Apple ID，点 Start"
echo "  3. iPhone：设置 → 通用 → VPN与设备管理 → 信任该描述文件"
