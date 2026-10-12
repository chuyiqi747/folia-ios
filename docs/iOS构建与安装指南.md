# iOS 构建与安装指南（TrollStore 路线）

> 这份文档对应的是**已经合好代码**的仓库状态。你不需要再手动合并任何文件，
> 只需要把仓库推到 GitHub，然后在 Actions 页面下载 IPA。

---

## 一、现在的状态

| 项目 | 状态 |
| --- | --- |
| 平台适配层（`src/platform/runtime.ts` 等） | ✅ 已合入 |
| 原生音频插件（`native/ios-plugin/`） | ✅ 已合入并通过校验 |
| `App.tsx` 接入点（锁屏控制 / 生命周期 / 键盘） | ✅ 已接入，`tsc --noEmit` 零错误 |
| 安全区与键盘 CSS | ✅ 已合入 `src/index.css` |
| iOS 工程（`ios/`） | ✅ 已生成，13 项自动校验全绿 |
| 云端构建工作流 | ✅ `.github/workflows/build-ios-ipa.yml` |
| 音源后端 | ❌ **需要你自己部署**（见第二节，否则 App 打开是空的） |

本地已经验证通过的东西：

```
$ npm run typecheck          → 退出码 0，零错误
$ npm run build:capacitor    → ✓ built in 5.48s
$ npx cap add ios            → Found 7 Capacitor plugins（含 folia-audio-session@1.0.0）
$ npm run cap:verify:ios     → 全部通过（13/13）
```

`cap add ios` 能自动发现我们自己写的插件，说明整条插件注册链路是通的 ——
这是这类工程最容易踩空的地方（插件没注册上时编译照样成功，只有运行时才发现）。

---

## 二、你只需要做三件事

### 步骤 1：建仓库并推送

```bash
cd folia-app
git add -A
git commit -m "feat(ios): 加入 iOS 平台支持与原生音频会话插件"
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

⚠️ 推之前确认这几件事：

- **仓库设为 Public**。私有仓库的 macOS runner 会消耗你的 Actions 免费额度
  （每月 2000 分钟，一次 iOS 构建约 5–10 分钟，够用但会慢慢耗）。
  公开仓库的 macOS 构建**免费且不限量**。
- `ios/` 目录会被一起推上去（约 30 个文件，不含构建产物）。
  这样 CI 不用再跑 `cap add ios`，少一层出错可能。

### 步骤 2：配置音源后端（**不配就等于装了个空壳**）

这是整个流程里最容易被忽略、但决定「能不能听歌」的一步。

**为什么必须做**：`VITE_*` 变量是**构建时内联**进 JS 的。仓库里 `.env.example`
的默认值是 `VITE_NETEASE_API_BASE=http://localhost:3000` —— 在 iPhone 上
`localhost` 指向手机自己，没有任何服务，所以搜索结果永远是空的。

**怎么做**：在 GitHub 仓库的 **Settings → Secrets and variables → Actions →
New repository secret** 里加下面这些：

| Secret 名 | 值 | 必需性 |
| --- | --- | --- |
| `VITE_NETEASE_API_BASE` | 你部署的网易云 API 地址，**必须 HTTPS** | 强烈建议 |
| `VITE_FOLIA_API_BASE` | AI 主题 + 歌词代理，**必须 HTTPS** | 可选 |
| `VITE_KUGOU_API_BASE` | 酷狗 API 地址 | 可选 |
| `VITE_QQ_API_BASE` | QQ 音乐 API 地址 | 可选 |

部署这些 API 的完整步骤见 **[后端部署指南.md](./后端部署指南.md)**
（Vercel 十分钟能搞定网易云 API）。

> **不配会怎样**：构建不会失败，App 也能装能开，但首页搜不到任何歌。
> 后面第四节的锁屏/后台测试也就没法做。所以建议**先配好再构建**。

### 步骤 3：触发构建并下载 IPA

推送后构建会**自动开始**。也可以手动触发：

**Actions → Build unsigned IPA → Run workflow**

手动触发时有个 `adhoc_sign` 开关，**默认不用开**。只有 TrollStore 装的时候
报 `Unsigned App` 才需要勾上重跑一次。

构建约 5–10 分钟，完成后：

1. 点进那次运行的详情页
2. 拉到底部 **Artifacts** 区域
3. 下载 `folia-unsigned-ipa`（是个 zip，解开里面是 `Folia-unsigned.ipa`）

#### 关于 package-lock.json 里的国内镜像地址

`package-lock.json` 里有约 1000 条 `resolved` 指向 `registry.npmmirror.com` ——
**这是上游 folia-sonnet 仓库本来就有的**（作者用国内镜像生成的 lockfile），
不是这次改动引入的。上游自己的 CI（`pr-unit-tests.yml` 等）一直用
`npm ci` 跑同一份 lockfile，所以在 GitHub runner 上是可用的。

已经实测确认 npmmirror 与 npmjs.org 提供的是**字节一致的 tarball**
（抽样 4 个包，integrity 哈希完全吻合），所以两个源可以互换。

- **对你本地是好事**：`npm install` 走国内镜像，快很多。
- **如果 CI 装依赖太慢**（从美国机房拉国内 CDN），可以切回官方源：
  ```bash
  rm -rf node_modules package-lock.json
  npm install --registry https://registry.npmjs.org/
  git add package-lock.json && git commit -m "chore: 切回官方 npm 源"
  ```


---

## 三、用 TrollStore 装到设备

### 3.1 先确认设备支持

TrollStore 的官方支持范围（来自 [opa334/TrollStore](https://github.com/opa334/TrollStore) 的 README）：

| 系统版本 | 是否支持 |
| --- | --- |
| 14.0 beta 2 – 16.6.1 | ✅ |
| 16.7 RC (20H18) | ✅ |
| 17.0 | ✅ |
| 16.7.x（除 RC 外的正式版） | ❌ 永远不会支持 |
| 17.0.1 及以上 | ❌ 永远不会支持 |

如果不在支持范围内，改走**侧载**（见 3.5）。

### 3.2 安装 IPA

最简单的方式是让设备自己去下：

1. 把 IPA 传到能公网访问的地方（GitHub Release / 你自己的网盘直链）
2. 在设备上用 Safari 打开：
   ```
   apple-magnifier://install?url=<IPA 的直链地址>
   ```
   系统会问是否用 TrollStore 打开，确认后点 Install

或者用数据线：

1. 把 `Folia-unsigned.ipa` 传到设备（AirDrop / iCloud Drive / 文件 App 都行）
2. 用文件 App 点它 → 分享 → 选 TrollStore
3. 点 Install

### 3.3 装完必须配「持久化助手」

**这步千万别跳。** TrollStore 是靠系统签名校验的漏洞工作的，
iOS 会在重启后重新校验，导致 App 打不开。

- 打开 TrollStore → **Settings** → **Install Persistence Helper**
- 它会让你选一个系统自带 App 来「寄生」（一般是「提示 Tips」）
- 装好后**重启一次设备**验证 App 还能开

### 3.4 如果报 `Unsigned App`

去 Actions 页面手动触发一次构建，**勾上 `adhoc_sign`**，用新 IPA 重试。

原因：TrollStore 的安装原理是用假根证书替换原签名，它要求二进制里
**存在**合法的签名结构（`LC_CODE_SIGNATURE`）。极少数情况下完全未签名的
二进制连这个结构都没有，TrollStore 就无法替换。加一个 ad-hoc 签名
（`codesign -s -`）就能解决。

### 3.5 备选：Sideloadly 侧载

设备不在 TrollStore 支持范围内时用这条。代价是：

| | TrollStore | Sideloadly（免费 Apple ID） |
| --- | --- | --- |
| 有效期 | 永久 | **7 天**，到期要重签 |
| 设备数限制 | 无 | 3 台 |
| 需要电脑 | 只在装的时候 | 每次续签都要 |
| 能否上架 App Store | 不能（那是另一条路） | 不能 |

步骤：Windows 装 [Sideloadly](https://sideloadly.io/)（**必须配苹果官网版
iTunes**，Microsoft Store 版缺 Wi-Fi 同步组件）→ 打开 IPA → 填 Apple ID → Start
→ 设备上「设置 → 通用 → VPN与设备管理 → 信任」。

---

## 四、装好后按这个顺序自测

**注意：模拟器验不了锁屏和后台播放**，必须用真机。

| # | 测什么 | 怎么测 | 预期 |
| --- | --- | --- | --- |
| 1 | 能启动 | 点图标 | 出现 Folia 启动图，然后进首页，**没有白屏** |
| 2 | 状态栏 | 看顶部 | 内容不被状态栏 / 灵动岛遮挡 |
| 3 | 音源通了 | 搜一首歌 | 有结果、有封面 |
| 4 | 能播放 | 点播放 | 出声 |
| 5 | **后台播放** | 播放中按 Home 键回桌面 | **音乐继续播**（这是 `UIBackgroundModes: audio` 生效的标志） |
| 6 | **锁屏信息** | 锁屏 | 显示歌名 / 歌手 / 封面 |
| 7 | **锁屏控制** | 在锁屏上按暂停、切下一首 | 都生效 |
| 8 | **耳机线控** | 按耳机中间键 | 播放 / 暂停切换 |
| 9 | **拔耳机** | 播放中拔掉耳机 | 自动暂停（不会突然外放） |
| 10 | **回前台对齐** | 后台放 2 分钟后回 App | 歌词跳到正确的行，锁屏进度和实际一致 |
| 11 | 键盘避让 | 点搜索框 | 输入框不被键盘挡住 |
| 12 | 旋转 / 分栏 | 横屏 | 布局正常（工程已配 `TARGETED_DEVICE_FAMILY = 1,2`，iPhone 和 iPad 都支持） |

第 5–10 项是这次改动的核心，如果都通过，说明原生音频层是好的。

**如果第 5 项不通过**（回桌面音乐就停了），基本只有一个原因：
`Info.plist` 里的 `UIBackgroundModes` 没生效。检查：

```bash
npm run cap:verify:ios
```

第 4 组检查会直接告诉你 `UIBackgroundModes = [audio]` 在不在。

---

## 五、出问题怎么排查

### 5.1 先跑自动校验

```bash
npm run cap:verify:ios
```

它会检查 13 项，覆盖插件包 / 注册清单 / SPM 引用 / 后台音频声明。
任何一项 ✗ 都会给出具体是哪个文件、哪个键有问题。

### 5.2 构建阶段失败

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `The workspace named "App" does not exist` | 用了 `-workspace` | Capacitor 8 默认 SPM，CLI 会删掉 `.xcworkspace`，必须用 `-project`（脚本里已经是对的） |
| `scheme "App" not found` | 用了 `-scheme` | 模板不含共享 scheme，必须用 `-target App`（脚本里已经是对的） |
| `npm ci` 报 lockfile 不一致 | 你改过 `package.json` 没重新生成 lock | 本地跑一次 `npm install` 再提交 `package-lock.json` |
| `EBADENGINE` | Node 版本低于 24 | workflow 里已经固定 `node-version: '24'` |

### 5.3 运行阶段没声音

打开 Safari 远程调试看 Console（需要一台 Mac）：

1. 设备：设置 → Safari → 高级 → 打开「网页检查器」
2. 用数据线连 Mac，Mac Safari → 开发 → [你的设备] → Folia
3. 这时能看到完整 Console

常见原因：

- **音源后端不通** —— Console 里会有一堆 `Failed to fetch`
- **歌曲需要 VIP / 登录** —— 网易云大量歌曲要登录才能拿到播放地址，在 App 里扫码登录
- **音频 URL 是 HTTP** —— iOS ATS 会直接掐断，必须 HTTPS

### 5.4 插件没注册上

症状：App 能跑，但锁屏什么都没有。

```bash
# 看 packageClassList 里有没有 FoliaAudioSessionPlugin
cat ios/App/App/capacitor.config.json
```

没有的话按顺序查：

1. `node_modules/folia-audio-session` 存在吗（`file:` 依赖装上了吗）
2. `native/ios-plugin/package.json` 里有 `"capacitor": { "ios": { "src": "ios" } }` 吗
3. Swift 文件里 `@objc(FoliaAudioSessionPlugin)` 还在吗（CLI 靠正则扫这个）

详细排查表见 [`native/ios-plugin/README.md`](../native/ios-plugin/README.md) 第六节。

---

## 六、上架 App Store 的差距

你说「测试好用再上架 App Store」。现在这套是**为 TrollStore 优化的未签名 IPA**，
上架需要另外准备：

| 项目 | 现状 | 上架需要 |
| --- | --- | --- |
| Apple 开发者账号 | 免费账号 | **付费账号**（$99/年） |
| 签名 | 未签名 / ad-hoc | 正式分发证书 + Provisioning Profile |
| 分发方式 | 直接装 IPA | TestFlight 或 App Store 审核 |
| `UIBackgroundModes: audio` | 已声明 | ⚠️ **会被重点审查**，要能说明后台音频是核心功能 |
| 本地网络权限 | 已声明 | 如果最终用云端 HTTPS 后端，可以去掉 |
| 相册权限 | 已声明 | 只保留真正用到的（歌词分享图导出），否则会被追问 |
| 版权风险 | — | ⚠️ 这类聚合第三方音源的 App **上架审核风险很高**，要有心理准备 |

工作流里的 `apply-ios-plist.sh` 支持用环境变量跳过不需要的权限：

```bash
FOLIA_LOCAL_NETWORK=0 FOLIA_PHOTO_LIBRARY=0 bash scripts/apply-ios-plist.sh
```

---

## 七、本地开发常用命令

```bash
# 类型检查
npm run typecheck

# 构建 Web 产物（Capacitor 目标）
npm run build:capacitor

# 生成 / 同步 iOS 工程 + 自动校验
npm run cap:add:ios       # 只在第一次需要
npm run cap:sync:ios      # 构建 + 同步 + 规范化 SPM 路径 + 校验

# 单独跑校验
npm run cap:verify:ios

# 在 Mac 上打开 Xcode
npm run cap:open:ios

# 在 Mac 上打未签名 IPA（CI 走的是同一条脚本）
npm run build:ios:unsigned
```

`build:ios:unsigned` 和 CI 用的是同一个 `scripts/build-ios-unsigned.sh`，
所以本地 Mac 和云端的行为完全一致，不会出现「本地能出包、CI 出不来」的问题。

---

## 附录：这次改动涉及的文件

### 新增

```
native/ios-plugin/                         原生音频会话插件（本地 npm 包）
  package.json                             capacitor.ios.src 指向 ios/
  Package.swift                            SPM 清单
  FoliaAudioSession.podspec                CocoaPods 兜底
  ios/Sources/FoliaAudioSession/
    FoliaAudioSessionPlugin.swift          ~500 行，AVAudioSession + NowPlaying + 远程命令
  README.md                                插件原理与排查

src/native/nativeAudioBridge.ts            插件 JS 封装（可用性探测 + 优雅降级）
src/hooks/useNativeNowPlaying.ts           锁屏 / 进度心跳 / 打断 / 路由变化编排
src/hooks/useNativeAppLifecycle.ts         前后台生命周期
src/hooks/useNativeKeyboardInset.ts        iOS 键盘避让

scripts/apply-ios-plist.sh                 幂等写 Info.plist（仅 macOS）
scripts/build-ios-unsigned.sh              编译 + 打包未签名 IPA（仅 macOS）
scripts/verify-ios-plugin.mjs              13 项自动校验（跨平台）
scripts/generate-ios-assets.mjs            图标与启动图（需要 @capacitor/assets）
scripts/fix-ios-spm-paths.mjs              修 Capacitor CLI 在 Windows 上的反斜杠路径 bug

.github/workflows/build-ios-ipa.yml        云端 macOS 构建
docs/后端部署指南.md                        音源后端部署
docs/iOS构建与安装指南.md                    本文档
resources/icon.png, splash-*.png           图标与启动图源图
ios/                                       已生成的 Xcode 工程
```

### 修改

```
package.json                 +4 个 Capacitor 依赖 +1 个本地插件 +11 个 iOS 脚本
capacitor.config.ts          追加 iosScheme / ios.contentInset
src/App.tsx                  +3 个 import，+2 处 hook 调用
src/platform/runtime.ts      新增 capacitor-ios 分支
src/hooks/useCapacitorSystemBars.ts   按平台分支（iOS 不支持 setOverlaysWebView）
src/index.css                追加安全区 / 键盘 / 原生滚动样式
.gitignore                   放行 iOS 脚本，排除 iOS 构建产物
```

### 关于两个"看起来像 bug 但其实是 CLI 问题"的点

1. **`CapApp-SPM/Package.swift` 在 Windows 上生成反斜杠路径**
   `@capacitor/cli` 的 `util/spm.js` 用 `path.relative()` 但没包
   `convertToUnixPath()`（同一个 CLI 的 `ios/update.js` 在别处是包了的）。
   Swift 字符串里 `\n` 是转义字符，所以那个文件在 macOS 上编译不过。
   CI 跑在 macOS 上不受影响，但仓库里提交的那份必须修 ——
   这就是 `scripts/fix-ios-spm-paths.mjs` 的用途，已接进 `cap:sync:ios` 和 CI。

2. **`Keyboard.resize` 不能写进 `capacitor.config.ts`**
   `@capacitor/keyboard` 的 `KeyboardResize` / `KeyboardStyle` 是 TS 字符串枚举
   （名义类型），config 里写字面量通不过 `tsc`。而且 iOS 的 WKWebView
   本来就不会因键盘 resize —— 键盘高度由 `useNativeKeyboardInset` 在运行时处理。
