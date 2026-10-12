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
#   FOLIA_BUILD_LOG=...  构建日志路径（默认 <仓库根>/build/xcodebuild.log）
#
# ---------------------------------------------------------------------------
# 【踩过的三个坑，改动前务必先读】
#
# 坑 1：脚本里任何可能跨 cd 使用的路径都必须是绝对路径。
#   最初脚本先 `cd ios/App`，再用相对路径 `build/xcodebuild.log` 去 tee，
#   结果写到了不存在的 `ios/App/build/`，tee 直接失败、日志没落盘，
#   于是失败分支里 `[ -f "${BUILD_LOG}" ]` 为假，连错误注解都发不出去 ——
#   表现为「构建失败但看不到任何原因」。
#   现在全程用绝对路径，且脚本不 cd（zip 用子 shell 切目录）。
#
# 坑 2：`-target` 与 `-derivedDataPath` 不能同时出现。
#   Xcode 会直接报错（退出码 64 = sysexits 的 EX_USAGE）：
#     "The flag -scheme, -testProductsPath, or -xctestrun is required
#      when specifying -derivedDataPath."
#   所以「-target + 指定 DerivedData」这种组合从来就是非法的，
#   要控制产物目录就必须用 -scheme。
#
# 坑 3：变量引用一律写 ${var}，不要写 $var。
#   macOS runner 的 locale 通常是 C/POSIX，bash 按**字节**解析变量名。
#   写成 `"==> 方式「$label」失败"` 时，`$label` 后面紧跟的中文引号 `」`
#   （UTF-8 三字节 E3 80 8D）会被当成变量名的一部分，在 `set -u` 下直接
#   报 `label?: unbound variable` 并终止脚本 —— 而且是静默地把真正的
#   构建错误盖掉，非常难查。加了花括号就有明确边界。
# ----------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PROJECT_DIR="${ROOT_DIR}/ios/App"
XCODEPROJ="${PROJECT_DIR}/App.xcodeproj"
OUT_DIR="${ROOT_DIR}/build"
APP_NAME="App"
IPA_NAME="Folia-unsigned.ipa"
BUILD_LOG="${FOLIA_BUILD_LOG:-${OUT_DIR}/xcodebuild.log}"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "✗ 找不到 xcodebuild —— 本脚本只能在 macOS 上运行。" >&2
  echo "  Windows 上请改用 GitHub Actions：见 docs/iOS构建与安装指南.md" >&2
  exit 1
fi

if [ ! -f "${XCODEPROJ}/project.pbxproj" ]; then
  echo "✗ 找不到 ${XCODEPROJ}" >&2
  echo "  先执行：npx cap add ios && npx cap sync ios" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

# ---------------------------------------------------------------------------
# 把日志内容转成 GitHub annotation 的消息体。
#
# 为什么需要这个：
#   annotation 是**匿名可读**的
#   （GET /repos/{owner}/{repo}/check-runs/{id}/annotations），
#   而完整 job logs 要带 token 才能下载。构建在云端失败时，把关键行转成
#   annotation，就能不依赖额外凭据定位问题。
#
# 转义规则：% 要写成 %25，换行写成 %0A，回车去掉。
# ---------------------------------------------------------------------------
emit_annotation() {
  local level="${1}"   # notice | warning | error
  local title="${2}"
  local body="${3}"
  if [ -z "${body}" ]; then
    return 0
  fi
  local encoded
  encoded=$(printf '%s' "${body}" \
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
#
# 副作用（有意为之）：`-list` 会顺带把 scheme 生成到 xcuserdata 里，
# 让后面的 -scheme 可用。
print_diagnostics() {
  local list_out showsdks_out
  list_out=$(xcodebuild -list -project "${XCODEPROJ}" 2>&1 || true)
  showsdks_out=$(xcodebuild -showsdks 2>&1 || true)
  echo "==> 工程诊断"
  echo "${list_out}" | sed 's/^/    /'
  emit_annotation notice "构建环境" "xcode-select: $(xcode-select -p 2>&1)
$(xcodebuild -version 2>&1)
---- xcodebuild -showsdks ----
${showsdks_out}
---- xcodebuild -list -project App.xcodeproj ----
${list_out}"
}

# ---------------------------------------------------------------------------
# 为什么是 -project 而不是 -workspace
#
# Capacitor 8 默认用 SPM，CLI 的 removeCocoapodsFiles() 会删掉 App.xcworkspace。
# 网上大量教程写的 -workspace 在 Capacitor 8 上会直接报文件不存在。
# ---------------------------------------------------------------------------
if [ -e "${PROJECT_DIR}/App.xcworkspace" ]; then
  echo "⚠️  检测到 App.xcworkspace（CocoaPods 模式）"
  echo "    本脚本按 SPM 模式用 -project 构建。若你确实在用 CocoaPods，"
  echo "    请把下面的 -project 换成 -workspace 并补上 -scheme。"
fi

echo "==> 编译（关闭签名）"
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

BUILD_OK=0
SUCCESS_MODE=""
FAILED_MODES=""

# ---------------------------------------------------------------------------
# try_build <标签> <xcodebuild 参数...>
#
# 失败时：把错误行与输出尾部**同时**打印到 stdout（job 日志里可见）
# 并累积到 FAILED_MODES。日志始终写到绝对路径 ${BUILD_LOG}，保证落盘。
# ---------------------------------------------------------------------------
try_build() {
  local label="${1}"; shift
  echo ""
  echo "==> 尝试构建方式：${label}"
  echo "    xcodebuild $*"

  set +e
  xcodebuild "$@" 2>&1 | tee "${BUILD_LOG}"
  local status=${PIPESTATUS[0]}
  set -e

  if [ "${status}" -eq 0 ]; then
    echo "==> 方式「${label}」构建成功"
    SUCCESS_MODE="${label}"
    return 0
  fi

  echo "==> 方式「${label}」失败（xcodebuild 退出码 ${status}）"
  echo "---- 该方式输出尾部 25 行 ----"
  tail -25 "${BUILD_LOG}" 2>/dev/null | sed 's/^/    /' || true
  echo "---- 尾部结束 ----"

  FAILED_MODES="${FAILED_MODES}${FAILED_MODES:+, }${label} (exit ${status})"
  return 1
}

BASE_FLAGS=(
  -project "${XCODEPROJ}"
  -configuration Release
  -sdk iphoneos
  "${SIGN_FLAGS[@]}"
)

# 三种方式依次尝试，第一个成功就停。
#
# 顺序依据：`print_diagnostics` 里的 `xcodebuild -list` 会把 scheme 生成出来，
# 所以 -scheme 是可用且更「正规」的入口；-target 作为最后的兜底。
#
#   方式 1：-scheme App + 指定 DerivedData
#     用 -scheme 才能配 -derivedDataPath（见文件头「坑 2」）。
#     指定 DerivedData 的好处是产物路径可预测，不用去
#     ~/Library/Developer/Xcode/DerivedData 里猜目录名。
#
#   方式 2：-scheme App + 默认 DerivedData
#     -derivedDataPath / -clonedSourcePackagesDirPath 是这里最「偏门」的两个参数，
#     如果某个 Xcode 版本对它们挑剔，去掉它们让 Xcode 用自己的默认位置。
#     产物改从 ~/Library/Developer/Xcode/DerivedData 下找。
#
#   方式 3：-target App + 默认 DerivedData
#     Capacitor 的 iOS 模板不含共享 scheme 时的最后兜底。
#     ⚠️ 绝不能带 -derivedDataPath，否则 Xcode 直接报 EX_USAGE（退出码 64）。
if try_build "-scheme App + 指定 DerivedData" \
  "${BASE_FLAGS[@]}" -scheme "${APP_NAME}" \
  -derivedDataPath "${OUT_DIR}" \
  -clonedSourcePackagesDirPath "${OUT_DIR}/spm" \
  build; then
  BUILD_OK=1
elif try_build "-scheme App + 默认 DerivedData" \
  "${BASE_FLAGS[@]}" -scheme "${APP_NAME}" \
  build; then
  BUILD_OK=1
elif try_build "-target App + 默认 DerivedData" \
  "${BASE_FLAGS[@]}" -target "${APP_NAME}" \
  build; then
  BUILD_OK=1
fi

if [ "${BUILD_OK}" -ne 1 ]; then
  echo "" >&2
  echo "✗ 三种构建方式全部失败：" >&2
  echo "    ${FAILED_MODES}" >&2
  echo "  完整日志：${BUILD_LOG}" >&2

  # 把错误行转成 annotation —— 这是不依赖额外凭据就能读到的方式
  if [ -f "${BUILD_LOG}" ]; then
    ERR_LINES=$(grep -iE "error:|fatal error|cannot find|not found|unable to|does not contain|no such|missing|denied|invalid option|unknown option|requires |Command .* failed|The following build commands failed" "${BUILD_LOG}" 2>/dev/null | head -30 || true)
    if [ -z "${ERR_LINES}" ]; then
      ERR_LINES=$(tail -30 "${BUILD_LOG}" 2>/dev/null || true)
    fi
    emit_annotation error "xcodebuild 错误行" "尝试过的方式：${FAILED_MODES}

${ERR_LINES}"

    TAIL_LINES=$(tail -45 "${BUILD_LOG}" 2>/dev/null || true)
    emit_annotation error "xcodebuild 输出尾部" "${TAIL_LINES}"
  else
    emit_annotation error "xcodebuild 未产生日志" "尝试过的方式：${FAILED_MODES}
预期日志路径：${BUILD_LOG}
（tee 未能写入 —— 通常是路径问题）"
  fi

  echo "  （错误行已作为 annotation 输出，也可用 token 下载 job logs 查看完整内容）" >&2
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
#   - 我们指定的 ${OUT_DIR}（方式 1）
#   - Xcode 默认的 ~/Library/Developer/Xcode/DerivedData/App-*/（方式 2 / 3）
APP_PATH=""
for candidate_dir in \
  "${OUT_DIR}/Build/Products/Release-iphoneos" \
  "${HOME}"/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Release-iphoneos
do
  if [ -d "${candidate_dir}" ]; then
    found=$(find "${candidate_dir}" -maxdepth 1 -name '*.app' 2>/dev/null | head -1)
    if [ -n "${found}" ]; then
      APP_PATH="${found}"
      echo "==> 在 ${candidate_dir} 找到产物"
      break
    fi
  fi
done

if [ -z "${APP_PATH}" ]; then
  echo "✗ 没找到编译产物 .app" >&2
  echo "  找过这些位置：" >&2
  echo "    ${OUT_DIR}/Build/Products/Release-iphoneos" >&2
  echo "    ~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Release-iphoneos" >&2
  ls -R "${OUT_DIR}/Build/Products" 2>/dev/null | head -60 >&2 || true
  emit_annotation error "找不到 .app 产物" "构建方式：${SUCCESS_MODE:-未知}
找过：${OUT_DIR}/Build/Products/Release-iphoneos 与 ~/Library/Developer/Xcode/DerivedData/App-*/
---- OUT_DIR/Build/Products 内容 ----
$(ls -R "${OUT_DIR}/Build/Products" 2>/dev/null | head -60 || echo '(不存在)')"
  exit 1
fi
echo "==> 编译产物：${APP_PATH}"

rm -rf "${OUT_DIR}/Payload"
mkdir -p "${OUT_DIR}/Payload"
cp -R "${APP_PATH}" "${OUT_DIR}/Payload/"

# 未签名包不该有任何签名残留，否则 Sideloadly 可能拒绝重签
rm -rf "${OUT_DIR}/Payload/${APP_NAME}.app/_CodeSignature"
rm -f "${OUT_DIR}/Payload/${APP_NAME}.app/embedded.mobileprovision"

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
  codesign --force --sign - "${OUT_DIR}/Payload/${APP_NAME}.app"

  # 嵌套的 framework / dylib 也要签，否则签名不完整
  find "${OUT_DIR}/Payload/${APP_NAME}.app" \
    \( -name '*.framework' -o -name '*.dylib' \) -print0 2>/dev/null |
    while IFS= read -r -d '' item; do
      codesign --force --sign - "${item}" 2>/dev/null || true
    done

  if codesign --verify --deep "${OUT_DIR}/Payload/${APP_NAME}.app" 2>/dev/null; then
    echo "    ad-hoc 签名校验通过"
  else
    echo "    ⚠️  签名校验未通过（可能不影响 TrollStore 安装，但值得留意）"
  fi
fi

rm -f "${OUT_DIR}/${IPA_NAME}"
# zip 必须在 Payload 的父目录执行，才能把 Payload/ 作为顶层条目写进去。
# 用子 shell 切目录，避免污染主流程的 cwd。
( cd "${OUT_DIR}" && zip -qry "${IPA_NAME}" Payload )

IPA_SIZE=$(du -h "${OUT_DIR}/${IPA_NAME}" | cut -f1)
echo "==> 打包完成：${OUT_DIR}/${IPA_NAME}（${IPA_SIZE}）"

# 让 Actions 页面的构建摘要带上产物大小与构建方式，方便确认
emit_annotation notice "构建成功" "构建方式：${SUCCESS_MODE}
产物：${OUT_DIR}/${IPA_NAME}（${IPA_SIZE}）"

echo ""
echo "下一步（在你的 Windows 上）："
echo "  1. 在 GitHub Actions 页面下载 artifact「folia-unsigned-ipa」"
echo "  2. 用 TrollStore 打开安装（详见 docs/iOS构建与安装指南.md 第三节）"
