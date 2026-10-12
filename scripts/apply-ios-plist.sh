#!/usr/bin/env bash
# ============================================================================
# apply-ios-plist.sh
#
# 幂等地给 Capacitor 生成的 ios/App/App/Info.plist 打上 Folia iOS 需要的键。
#
# 为什么需要这个脚本：
#   1. `npx cap add ios` 每次都会用模板重新生成 Info.plist，手改的键会丢。
#      放进 CI 的固定步骤里，才能保证每次构建的权限声明一致。
#   2. 反复执行必须安全（幂等）——已存在的键保留不动，不覆盖用户的自定义值。
#
# ⚠️ 只能在 macOS 上运行（依赖 PlistBuddy）。
#
# 用法：
#   bash scripts/apply-ios-plist.sh [plist 路径]
#   默认路径：ios/App/App/Info.plist
#
# 环境变量：
#   FOLIA_LOCAL_NETWORK=0   跳过本地网络权限（纯云端部署时不需要）
#   FOLIA_PHOTO_LIBRARY=0   跳过相册权限（不用歌词分享图 / 自定义封面时）
# ============================================================================

set -euo pipefail

PLIST="${1:-ios/App/App/Info.plist}"
PB=/usr/libexec/PlistBuddy

if [ ! -f "$PLIST" ]; then
  echo "✗ 找不到 $PLIST" >&2
  echo "  先执行 npx cap add ios 生成 iOS 工程。" >&2
  exit 1
fi

if [ ! -x "$PB" ]; then
  echo "✗ 找不到 $PB —— 本脚本只能在 macOS 上运行。" >&2
  exit 1
fi

ADDED=0
KEPT=0

# 键是否已存在（PlistBuddy 的 Print 对不存在的键返回非零）
has_key() {
  $PB -c "Print :$1" "$PLIST" >/dev/null 2>&1
}

# 数组里是否已包含某值
array_has() {
  $PB -c "Print :$1" "$PLIST" 2>/dev/null | grep -qx "[[:space:]]*$2"
}

echo "==> 打补丁：$PLIST"

# ---------------------------------------------------------------------------
# 1. 后台音频 —— iOS 版最关键的键
#
#    缺了它，App 一退到后台 WKWebView 就立刻暂停 HTMLAudioElement。
#    即使 AVAudioSession 设成 .playback 也没用 —— 这个 plist 键是前提，
#    原生代码里的 setCategory(.playback) 是必要条件，两者缺一不可。
# ---------------------------------------------------------------------------
if has_key "UIBackgroundModes"; then
  if array_has "UIBackgroundModes" "audio"; then
    echo "  = UIBackgroundModes 已含 audio"
    KEPT=$((KEPT + 1))
  else
    $PB -c "Add :UIBackgroundModes:0 string audio" "$PLIST" >/dev/null
    echo "  + UIBackgroundModes += audio"
    ADDED=$((ADDED + 1))
  fi
else
  $PB -c "Add :UIBackgroundModes array" "$PLIST" >/dev/null
  $PB -c "Add :UIBackgroundModes:0 string audio" "$PLIST" >/dev/null
  echo "  + UIBackgroundModes = [audio]"
  ADDED=$((ADDED + 1))
fi

# ---------------------------------------------------------------------------
# 2. 状态栏样式交给代码控制
#
#    模板默认已是 true，这里只是保证 —— useCapacitorSystemBars.ts 依赖它。
#    若为 false，@capacitor/status-bar 的 setStyle 在 iOS 上不生效。
# ---------------------------------------------------------------------------
if has_key "UIViewControllerBasedStatusBarAppearance"; then
  echo "  = UIViewControllerBasedStatusBarAppearance 已存在"
  KEPT=$((KEPT + 1))
else
  $PB -c "Add :UIViewControllerBasedStatusBarAppearance bool true" "$PLIST" >/dev/null
  echo "  + UIViewControllerBasedStatusBarAppearance = true"
  ADDED=$((ADDED + 1))
fi

# ---------------------------------------------------------------------------
# 3. 本地网络权限（自建 Navidrome / 局域网后端需要）
#
#    iOS 14+ 访问局域网设备会弹权限框。缺这条描述会被系统直接拒绝，
#    且弹窗里显示空文案 —— 用户只会看到一个没有说明的权限请求。
# ---------------------------------------------------------------------------
if [ "${FOLIA_LOCAL_NETWORK:-1}" = "1" ]; then
  if has_key "NSLocalNetworkUsageDescription"; then
    echo "  = NSLocalNetworkUsageDescription 已存在"
    KEPT=$((KEPT + 1))
  else
    $PB -c "Add :NSLocalNetworkUsageDescription string Folia 需要访问本地网络，以连接你自建的 Navidrome 音乐服务与音源后端。" "$PLIST" >/dev/null
    echo "  + NSLocalNetworkUsageDescription"
    ADDED=$((ADDED + 1))
  fi
fi

# ---------------------------------------------------------------------------
# 4. 相册权限（歌词分享图导出 / 自定义封面）
#
#    只申请 Add（写入）也可以，但 folia 的自定义封面要读相册，所以两个都要。
#    用不到就把 FOLIA_PHOTO_LIBRARY=0 —— 申请用不到的权限会被审核追问。
# ---------------------------------------------------------------------------
if [ "${FOLIA_PHOTO_LIBRARY:-1}" = "1" ]; then
  if has_key "NSPhotoLibraryAddUsageDescription"; then
    echo "  = NSPhotoLibraryAddUsageDescription 已存在"
    KEPT=$((KEPT + 1))
  else
    $PB -c "Add :NSPhotoLibraryAddUsageDescription string Folia 需要保存图片到相册，以便导出歌词卡片分享图。" "$PLIST" >/dev/null
    echo "  + NSPhotoLibraryAddUsageDescription"
    ADDED=$((ADDED + 1))
  fi

  if has_key "NSPhotoLibraryUsageDescription"; then
    echo "  = NSPhotoLibraryUsageDescription 已存在"
    KEPT=$((KEPT + 1))
  else
    $PB -c "Add :NSPhotoLibraryUsageDescription string Folia 需要读取相册，以便你选择图片作为自定义封面。" "$PLIST" >/dev/null
    echo "  + NSPhotoLibraryUsageDescription"
    ADDED=$((ADDED + 1))
  fi
fi

# ---------------------------------------------------------------------------
# 5. ATS —— 允许访问 localhost 的 HTTP 后端
#
#    只开 localhost 例外，不开 NSAllowsArbitraryLoads。
#    全局放开明文 HTTP 是上架审核的高频拒绝原因。
#    部署到 Vercel / Cloudflare 后是 HTTPS，这个例外用不到但留着无害。
# ---------------------------------------------------------------------------
if has_key "NSAppTransportSecurity"; then
  echo "  = NSAppTransportSecurity 已存在（保留你已有的配置）"
  KEPT=$((KEPT + 1))
else
  $PB -c "Add :NSAppTransportSecurity dict" "$PLIST" >/dev/null
  $PB -c "Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool false" "$PLIST" >/dev/null
  $PB -c "Add :NSAppTransportSecurity:NSExceptionDomains dict" "$PLIST" >/dev/null
  $PB -c "Add :NSAppTransportSecurity:NSExceptionDomains:localhost dict" "$PLIST" >/dev/null
  $PB -c "Add :NSAppTransportSecurity:NSExceptionDomains:localhost:NSExceptionAllowsInsecureHTTPLoads bool true" "$PLIST" >/dev/null
  $PB -c "Add :NSAppTransportSecurity:NSExceptionDomains:localhost:NSIncludesSubdomains bool true" "$PLIST" >/dev/null
  echo "  + NSAppTransportSecurity（仅 localhost 例外，未开全局明文）"
  ADDED=$((ADDED + 1))
fi

# ---------------------------------------------------------------------------
# 故意不设置的两个键（说明为什么）
#
#   UIUserInterfaceStyle
#     folia 有浅色 / 深色两套主题（代码里的 isDaylight）。
#     设成 Dark 会强制全局深色，浅色主题失效。必须留给代码控制。
#
#   UIApplicationExitsOnSuspend
#     已在 iOS 13 移除。保留这个键（无论 true/false）都可能被审核质疑，
#     而且对现代 iOS 完全没有作用。
#
#   IgnoreSilentSwitch
#     这不是 iOS 的 Info.plist 键，是某些 Cordova 媒体插件的配置项。
#     本项目用 AVAudioSession 的 .playback 类别，本身就不受静音开关影响，
#     不需要它。
# ---------------------------------------------------------------------------

echo "==> 完成：新增 $ADDED 项，保留 $KEPT 项"

# 语法校验
if ! plutil -lint "$PLIST" >/dev/null 2>&1; then
  echo "✗ plutil 校验失败，Info.plist 可能已损坏" >&2
  plutil -lint "$PLIST" >&2 || true
  exit 1
fi
echo "==> plutil 语法校验通过"
