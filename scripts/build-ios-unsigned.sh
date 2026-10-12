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
#
# 环境变量：
#   FOLIA_ADHOC_SIGN=1   打包前做 ad-hoc 签名（TrollStore 报 Unsigned App 时用）
#   FOLIA_BUILD_LOG=...  构建日志路径（默认 build/xcodebuild.log）
# ============================================================================

set -euo pipefail

PROJECT_DIR="ios/App"
OUT_DIR="build"
APP_NAME="App"
IPA_NAME="Folia-unsigned.ipa"
BUILD_LOG="${FOLIA_BUILD_LOG:-$OUT_DIR/xcodebuild.log}"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "✗ 找不到 xcodebuild —— 本脚本只能在 macOS 上运行。" >&2
  echo "  Windows 上请改用 GitHub Actions：见 docs/iOS构建与安装指南.md" >&2
  exit 1
fi

if [ ! -f "$PROJECT_DIR/App.xcodeproj/project.pbxproj" ]; then
  echo "✗ 找不到 $PROJECT_DIR/App.xcodeproj" >&2
  echo "  先执行：npx cap add ios && npx cap sync ios" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# ---------------------------------------------------------------------------
# 把日志内容转成 GitHub annotation 的消息体。
#
# 为什么需要这个：
#   GitHub Actions 的完整日志下载接口要登录（匿名请求返回
#   "Must have admin rights to Repository"），但 annotation 是**匿名可读**的
#   （GET /repos/{owner}/{repo}/check-runs/{id}/annotations）。
#   构建在云端失败时，把关键行转成 annotation，就能不依赖登录定位问题。
#
# 转义规则：% 要写成 %25，换行写成 %0A，回车去掉。
# ---------------------------------------------------------------------------
emit_annotation() {
  local level="$1"   # notice | warning | error
  local title="$2"
  local body="$3"
  if [ -z "$body" ]; then
    return 0
  fi
  local encoded
  encoded=$(printf '%s' "$body" \
    | tr -d '\r' \
    | sed -e 's/%/%25/g' \
    | awk '{ if (NR==1) printf "%s", $0; else printf "%%0A%s", $0 }')
  # annotation 消息体有长度上限，超了会被整条丢弃，这里保守截断
  if [ "${#encoded}" -gt 6000 ]; then
    encoded="${encoded:0:6000}%0A…（已截断）"
  fi
  echo "::${level} title=${title}::${encoded}"
}

# 诊断信息：Xcode 版本、当前选的工具链、工程里实际有哪些 target / scheme、
# 装了哪些 SDK。全部通过 notice 暴露出来，匿名也能读到。
#
# 为什么连 SDK 都要打：xcodebuild 因为参数或环境问题失败时退出码是 64
# （sysexits.h 的 EX_USAGE），而「-sdk iphoneos 找不到设备 SDK」也归在这类，
# 光看退出码区分不出来。把 -showsdks 的结果摊开就能一眼确认。
print_diagnostics() {
  local list_out showsdks_out
  list_out=$(xcodebuild -list -project App.xcodeproj 2>&1 || true)
  showsdks_out=$(xcodebuild -showsdks 2>&1 || true)
  echo "==> 工程诊断"
  echo "$list_out" | sed 's/^/    /'
  emit_annotation notice "构建环境" "xcode-select: $(xcode-select -p 2>&1)
$(xcodebuild -version 2>&1)
---- xcodebuild -showsdks ----
$showsdks_out
---- xcodebuild -list -project App.xcodeproj ----
$list_out"
}

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

echo "==> 编译（关闭签名）"
cd "$PROJECT_DIR"

print_diagnostics

# ---------------------------------------------------------------------------
# 关闭签名相关的设置。
# 我们只要未签名的 .app，签名交给设备端（TrollStore / Sideloadly）。
# 这样构建阶段完全不需要 Apple 账号。
# ---------------------------------------------------------------------------
SIGN_FLAGS=(
  CODE_SIGNING_ALLOWED=NO
  CODE_SIGNING_REQUIRED=NO
  CODE_SIGN_IDENTITY=""
  CODE_SIGNING_ENTITLEMENTS=""
)

# ---------------------------------------------------------------------------
# 两种构建方式，按顺序尝试。
#
#   方式 1：-target App
#     Capacitor 的 iOS 模板不含共享 scheme（xcshareddata/xcschemes/ 为空），
#     而 scheme 是 Xcode 打开工程时才自动生成的。所以 -scheme 在纯 CI 上
#     可能报 "scheme not found" —— 这就是当初选 -target 的理由。
#
#   方式 2：-scheme App
#     兜底。上面那句 `xcodebuild -list` 通常会把 scheme 生成到
#     xcuserdata 里，之后 -scheme 就能用了。
#     如果 -target 因为别的原因（Xcode 版本差异）失败，这里能接住。
#
# 两种都失败才真正退出，并把错误行转成 annotation 暴露出去。
# ---------------------------------------------------------------------------
BUILD_OK=0
SUCCESS_MODE=""
FAILED_MODES=""

try_build() {
  local label="$1"; shift
  echo ""
  echo "==> 尝试构建方式：$label"
  echo "    xcodebuild $*"
  set +e
  # 同时写文件和终端：终端给人看，文件给 annotation 用
  xcodebuild "$@" 2>&1 | tee "$BUILD_LOG"
  local status=${PIPESTATUS[0]}
  set -e
  if [ "$status" -eq 0 ]; then
    echo "==> 方式「$label」构建成功"
    SUCCESS_MODE="$label"
    return 0
  fi
  echo "==> 方式「$label」失败（xcodebuild 退出码 $status）"
  FAILED_MODES="${FAILED_MODES}${FAILED_MODES:+, }$label (exit $status)"
  return 1
}

BASE_FLAGS=(
  -project App.xcodeproj
  -configuration Release
  -sdk iphoneos
  "${SIGN_FLAGS[@]}"
)

# 三种方式依次尝试，第一个成功就停。
#
#   方式 1：-target App + 指定 DerivedData
#     Capacitor 的 iOS 模板不含共享 scheme（xcshareddata/xcschemes/ 为空），
#     而 scheme 是 Xcode 打开工程时才自动生成的，所以纯 CI 上 -scheme 可能
#     报 "scheme not found" —— 这是当初选 -target 的理由。
#
#   方式 2：-scheme App + 指定 DerivedData
#     上面那句 `xcodebuild -list` 通常会把 scheme 生成到 xcuserdata 里，
#     之后 -scheme 就能用了。用于接住 -target 在部分 Xcode 版本上的失败。
#
#   方式 3：-scheme App，不指定 DerivedData
#     -derivedDataPath / -clonedSourcePackagesDirPath 是这里最「偏门」的两个参数，
#     如果某个 Xcode 版本对它们挑剔（报 EX_USAGE 也就是退出码 64），
#     去掉它们让 Xcode 用自己的默认位置，是最保守的兜底。
#     产物改从 ~/Library/Developer/Xcode/DerivedData 下找。
if try_build "-target App + 指定 DerivedData" \
  "${BASE_FLAGS[@]}" -target "$APP_NAME" \
  -derivedDataPath "../../$OUT_DIR" \
  -clonedSourcePackagesDirPath "../../$OUT_DIR/spm" \
  build; then
  BUILD_OK=1
elif try_build "-scheme App + 指定 DerivedData" \
  "${BASE_FLAGS[@]}" -scheme "$APP_NAME" \
  -derivedDataPath "../../$OUT_DIR" \
  -clonedSourcePackagesDirPath "../../$OUT_DIR/spm" \
  build; then
  BUILD_OK=1
elif try_build "-scheme App + 默认 DerivedData" \
  "${BASE_FLAGS[@]}" -scheme "$APP_NAME" \
  build; then
  BUILD_OK=1
fi

cd - >/dev/null

if [ "$BUILD_OK" -ne 1 ]; then
  echo "" >&2
  echo "✗ 三种构建方式全部失败：" >&2
  echo "    $FAILED_MODES" >&2
  echo "  完整日志：$BUILD_LOG" >&2

  # 把错误行转成 annotation —— 这是匿名唯一能读到的方式
  if [ -f "$BUILD_LOG" ]; then
    ERR_LINES=$(grep -iE "error:|error |fatal error|cannot|not found|unable to|does not contain|no such|missing|denied|invalid option|unknown option|requires" "$BUILD_LOG" 2>/dev/null | head -25 || true)
    emit_annotation error "xcodebuild 错误行" "尝试过的方式：$FAILED_MODES
$ERR_LINES"

    TAIL_LINES=$(tail -40 "$BUILD_LOG" 2>/dev/null || true)
    emit_annotation error "xcodebuild 输出尾部 40 行" "$TAIL_LINES"
  fi

  echo "  （错误行已作为 annotation 输出，可在 Actions 页面顶部或通过 Checks API 查看）" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 打包。不用 xcodebuild -exportArchive —— 那是为「带签名的分发」设计的，
# 在完全没有签名身份时会失败。未签名 IPA 的标准结构就是一个 zip：
#     <名字>.ipa
#     └── Payload/
#         └── App.app/
# ---------------------------------------------------------------------------
# 产物可能落在两个地方：
#   - 我们指定的 $OUT_DIR（方式 1 / 2）
#   - Xcode 默认的 ~/Library/Developer/Xcode/DerivedData/App-*/（方式 3）
APP_PATH=""
for candidate_dir in \
  "$OUT_DIR/Build/Products/Release-iphoneos" \
  "$HOME"/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Release-iphoneos
do
  if [ -d "$candidate_dir" ]; then
    found=$(find "$candidate_dir" -maxdepth 1 -name '*.app' 2>/dev/null | head -1)
    if [ -n "$found" ]; then
      APP_PATH="$found"
      echo "==> 在 $candidate_dir 找到产物"
      break
    fi
  fi
done

if [ -z "$APP_PATH" ]; then
  echo "✗ 没找到编译产物 .app" >&2
  echo "  找过这些位置：" >&2
  echo "    $OUT_DIR/Build/Products/Release-iphoneos" >&2
  echo "    ~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Release-iphoneos" >&2
  ls -R "$OUT_DIR/Build/Products" 2>/dev/null | head -60 >&2 || true
  emit_annotation error "找不到 .app 产物" "构建方式：${SUCCESS_MODE:-未知}
找过：$OUT_DIR/Build/Products/Release-iphoneos 与 ~/Library/Developer/Xcode/DerivedData/App-*/
---- \$OUT_DIR/Build/Products 内容 ----
$(ls -R "$OUT_DIR/Build/Products" 2>/dev/null | head -60 || echo '(不存在)')"
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

IPA_SIZE=$(du -h "$OUT_DIR/$IPA_NAME" | cut -f1)
echo "==> 打包完成：$OUT_DIR/$IPA_NAME（$IPA_SIZE）"

# 让 Actions 页面的构建摘要带上产物大小与构建方式，方便确认
emit_annotation notice "构建成功" "构建方式：$SUCCESS_MODE
产物：$OUT_DIR/$IPA_NAME（$IPA_SIZE）"

echo ""
echo "下一步（在你的 Windows 上）："
echo "  1. 在 GitHub Actions 页面下载 artifact「folia-unsigned-ipa」"
echo "  2. 用 TrollStore 打开安装（详见 docs/iOS构建与安装指南.md 第三节）"
