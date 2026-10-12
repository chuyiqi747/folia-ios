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
# 5. ATS —— 允许访问 localhost / 局域网的 HTTP 后端
#
#    背景：音源服务（NeteaseCloudMusicApi）是跑在你自己电脑上的 HTTP 服务。
#    三种接法：
#      a) 隧道（https）      —— 不用改 ATS，但走国外中转，很慢
#      b) 局域网直连         —— http://192.168.x.x:3000，最快，但需要本地网络例外
#      c) localhost 本机     —— 仅当服务跑在设备上时才有意义
#
#    这里只开必要的三个开关，仍然【不开】NSAllowsArbitraryLoads：
#      - NSAllowsLocalNetworking             允许明文访问局域网私有地址（10/172.16-31/192.168）
#      - NSAllowsArbitraryLoadsInWebContent  允许 WKWebView 里发起明文请求。
#        为什么必须单独开这个：页面本身是 https://localhost（Capacitor 的 iosScheme），
#        从 https 页面请求 http://192.168.x.x 属于「混合内容」，
#        WebKit 会直接拦掉 —— 只开 NSAllowsLocalNetworking 是不够的。
#        这个键只影响 WebView 内容，不像 NSAllowsArbitraryLoads 那样全局放开，
#        上架审核风险小得多（而且它本来就是给混合 App 用的标准键）。
# ---------------------------------------------------------------------------
if ! has_key "NSAppTransportSecurity"; then
  $PB -c "Add :NSAppTransportSecurity dict" "$PLIST" >/dev/null
  echo "  + NSAppTransportSecurity"
  ADDED=$((ADDED + 1))
else
  echo "  = NSAppTransportSecurity 已存在，逐项补齐"
  KEPT=$((KEPT + 1))
fi

# 5.1 显式声明不全局放开明文（审核友好，也表明我们的意图）
if has_key "NSAppTransportSecurity:NSAllowsArbitraryLoads"; then
  echo "  = NSAllowsArbitraryLoads 已存在"
else
  $PB -c "Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool false" "$PLIST" >/dev/null
  echo "  + NSAllowsArbitraryLoads = false"
  ADDED=$((ADDED + 1))
fi

# 5.2 局域网明文（10.x / 172.16-31.x / 192.168.x / .local）
if has_key "NSAppTransportSecurity:NSAllowsLocalNetworking"; then
  echo "  = NSAllowsLocalNetworking 已存在"
else
  $PB -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$PLIST" >/dev/null
  echo "  + NSAllowsLocalNetworking = true（局域网直连音源）"
  ADDED=$((ADDED + 1))
fi

# 5.3 WKWebView 内允许明文（否则 https 页面请求 http 后端会被当混合内容拦掉）
if has_key "NSAppTransportSecurity:NSAllowsArbitraryLoadsInWebContent"; then
  echo "  = NSAllowsArbitraryLoadsInWebContent 已存在"
else
  $PB -c "Add :NSAppTransportSecurity:NSAllowsArbitraryLoadsInWebContent bool true" "$PLIST" >/dev/null
  echo "  + NSAllowsArbitraryLoadsInWebContent = true（WebView 内允许 http 音源）"
  ADDED=$((ADDED + 1))
fi

# 5.4 localhost 例外（保留原有行为）
if ! has_key "NSAppTransportSecurity:NSExceptionDomains"; then
  $PB -c "Add :NSAppTransportSecurity:NSExceptionDomains dict" "$PLIST" >/dev/null
  ADDED=$((ADDED + 1))
fi
if ! has_key "NSAppTransportSecurity:NSExceptionDomains:localhost"; then
  $PB -c "Add :NSAppTransportSecurity:NSExceptionDomains:localhost dict" "$PLIST" >/dev/null
  $PB -c "Add :NSAppTransportSecurity:NSExceptionDomains:localhost:NSExceptionAllowsInsecureHTTPLoads bool true" "$PLIST" >/dev/null
  $PB -c "Add :NSAppTransportSecurity:NSExceptionDomains:localhost:NSIncludesSubdomains bool true" "$PLIST" >/dev/null
  echo "  + NSExceptionDomains:localhost（允许明文）"
  ADDED=$((ADDED + 1))
else
  echo "  = NSExceptionDomains:localhost 已存在"
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
