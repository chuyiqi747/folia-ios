# folia-audio-session —— 本地 Capacitor 插件包

原生音频会话插件。**只含原生代码**，JS 侧封装在 App 的 `src/native/nativeAudioBridge.ts`。

---

## 一、为什么插件要打包成 npm 包，而不是直接把 Swift 文件拖进 Xcode

这是整个 iOS 改造里最容易踩的坑，值得说清楚。

Capacitor 的插件发现分两步，**两步都不看 Xcode target**：

### 第 1 步：编译期 —— CLI 扫描源码，生成类名清单

`npx cap sync ios` 会执行 `cli/src/util/spm.ts` 里的逻辑：

```
package.json 的 dependencies
        ↓  resolvePlugin() 读每个包的 package.json
只保留带 capacitor.ios 字段的包
        ↓  plugin.ios.path = capacitor.ios.src   （本例 = "ios"）
递归扫描 node_modules/<包名>/ios/ 下所有 .swift 和 .m
        ↓  findPluginClasses() 用正则提取类名
   /@objc\(([A-Za-z0-9_-]+)\)/     ← 匹配 Swift 的 @objc(...)
   /CAP_PLUGIN\(([A-Za-z0-9_-]+)/  ← 匹配 ObjC 的 CAP_PLUGIN(...)
        ↓
写入 ios/App/App/capacitor.config.json 的 packageClassList 字段
```

**注意 `writePluginJSON` 是「读取现有文件 → 整体替换 `packageClassList`」**。这意味着：
手动往 `capacitor.config.json` 里加的类名，下一次 `cap sync` 就会被覆盖掉。

### 第 2 步：运行期 —— 按类名反射查找

`CapacitorBridge.registerPlugins()`（`ios/Capacitor/Capacitor/CapacitorBridge.swift`）：

```swift
if let pluginJSON = Bundle.main.url(forResource: "capacitor.config", withExtension: "json") {
    let registrationList = try JSONDecoder().decode(RegistrationList.self, from: pluginData)
    for plugin in registrationList.packageClassList {
        if let pluginClass = NSClassFromString(plugin) {   // ← 靠字符串找类
            pluginList.append(pluginClass)
        }
    }
}
...
if let capPlugin = plugin as? CapacitorPlugin.Type {   // CapacitorPlugin = CAPPlugin & CAPBridgedPlugin
    registerPlugin(capPlugin)
}
```

所以插件必须同时满足：

| 条件 | 由谁保证 |
|---|---|
| 类名出现在 `packageClassList` | 打包成 npm 包，让 CLI 扫到 |
| `NSClassFromString` 能找到这个类 | Swift 类必须有 `@objc(类名)` + 继承 `CAPPlugin` |
| 通过 `as? CapacitorPlugin` 转换 | 必须实现 `CAPBridgedPlugin` 协议 |

**把 Swift 文件拖进 Xcode target 只能满足第 2 条**（类被编译进二进制），第 1 条会失效 —— 于是 `NSClassFromString` 那一轮循环里根本没有这个名字，插件永远不会被注册，JS 调用直接 reject。而且这个问题很隐蔽：编译一切正常，只有运行时插件「不存在」。

---

## 二、包名 → 类名的推导规则（改名前必读）

CLI 的 `fixName()`（`cli/src/plugin.ts`）把包名转成 SPM 里的名字：

```js
name.replace(/\//g, '_').replace(/-/g, '_').replace(/@/g, '')
    .replace(/_\w/g, m => m[1].toUpperCase())     // _a → A
    .replace(/^./, c => c.toUpperCase())          // 首字母大写
```

本包：`folia-audio-session` → `folia_audio_session` → `foliaAudioSession` → **`FoliaAudioSession`**

这个结果被 CLI 当作 `plugin.ios.name`，会**原样**写进生成的两处：

```swift
// ios/App/CapApp-SPM/Package.swift
.package(name: "FoliaAudioSession", path: "../../node_modules/folia-audio-session")
.product(name: "FoliaAudioSession", package: "FoliaAudioSession")
```

```ruby
# ios/App/Podfile（CocoaPods 模式）
pod 'FoliaAudioSession', :path => '...'
```

所以下面三处的名字必须**完全一致**，改一个就得改全部：

| 位置 | 值 |
|---|---|
| 本包 `Package.swift` 的 `package(name:)` | `FoliaAudioSession` |
| 本包 `Package.swift` 的 `products[].library(name:)` | `FoliaAudioSession` |
| 本包 `FoliaAudioSession.podspec` 的文件名与 `spec.name` | `FoliaAudioSession` |
| Swift 里 `@objc(...)` 的参数 | `FoliaAudioSessionPlugin`（**注意带 Plugin 后缀，这是类名不是包名**） |
| Swift 里 `identifier` | `FoliaAudioSessionPlugin` |
| Swift 里 `jsName` | `FoliaAudioSession`（JS 侧 `registerPlugin('FoliaAudioSession')` 对应它） |

不一致的典型报错：

- `Unknown package 'X' in dependencies of target 'CapApp-SPM'` → Package.swift 的 name 对不上
- `product 'X' required by package 'Y' target 'CapApp-SPM' not found` → library name 对不上
- JS 侧 `"FoliaAudioSession" plugin is not implemented on ios` → `@objc` 名字不对，或没进 packageClassList

---

## 三、不要同时用 Swift 和 ObjC 两套注册方式

Capacitor 有两条注册路径，**只能选一条**：

| 方式 | 写法 | 适用 |
|---|---|---|
| Swift（推荐，Capacitor 8 官方做法） | `class X: CAPPlugin, CAPBridgedPlugin` + `@objc(X)` + `identifier` / `jsName` / `pluginMethods` | 纯 Swift 插件 |
| ObjC（旧） | `.m` 里写 `CAP_PLUGIN(X, "jsName", CAP_PLUGIN_METHOD(...))` | ObjC 插件或 Cordova 兼容 |

`CAP_PLUGIN` 宏展开后会在类上定义一个 category，**同样声明 `identifier` / `jsName` / `pluginMethods`**。
如果 Swift 类里也有这三个属性，ObjC 侧就是重复定义，链接期报
`duplicate symbol` 或属性冲突。

所以本包**只有 Swift 文件，没有 `.m`**。类名靠 Swift 的 `@objc(FoliaAudioSessionPlugin)` 被 CLI 正则扫到，
不需要 `CAP_PLUGIN` 兜底。

---

## 四、接入步骤

### 1. 把包放进项目

```bash
# 假设 folia-sonnet 的 fork 在 ~/folia
cd ~/folia
mkdir -p native
cp -r <本目录> native/ios-plugin
```

然后改根 `package.json`，加一条 `file:` 依赖：

```json
{
  "dependencies": {
    "@capacitor/core": "^8.0.0",
    "@capacitor/ios": "^8.0.0",
    "folia-audio-session": "file:./native/ios-plugin"
  }
}
```

```bash
npm install
```

装完后确认一下（`file:` 依赖 npm 会做符号链接或拷贝，两种都行）：

```bash
ls node_modules/folia-audio-session/Package.swift          # 必须存在
cat node_modules/folia-audio-session/package.json | grep -A3 capacitor
```

### 2. 首次添加 iOS 平台

```bash
npm run build:capacitor        # 产出 dist/
npx cap add ios
```

### 3. 同步，让 CLI 生成注册清单

```bash
npx cap sync ios
```

这一步之后**必须**校验两件事，它们是整个接入的成败判据：

```bash
# 判据 1：类名进了清单
cat ios/App/App/capacitor.config.json | grep -o 'FoliaAudioSessionPlugin'
# 期望输出：FoliaAudioSessionPlugin

# 判据 2：SPM 引用了本包
grep -n 'FoliaAudioSession' ios/App/CapApp-SPM/Package.swift
# 期望输出两行：
#   .package(name: "FoliaAudioSession", path: "../../node_modules/folia-audio-session")
#   .product(name: "FoliaAudioSession", package: "FoliaAudioSession")
```

如果判据 1 没输出，说明 CLI 没扫到包 —— 回去检查 `capacitor.ios.src` 和 `node_modules` 里是否真的有这个目录。
如果判据 2 没输出，说明 `Package.swift` 没被识别 —— 检查本包根目录的 `Package.swift` 是否存在且 `name` 为 `FoliaAudioSession`。

### 4. 加上 Info.plist 权限

把 `resources/Info.plist.snippet.xml` 里的键合并进 `ios/App/App/Info.plist`。
**其中 `UIBackgroundModes = audio` 是后台播放的硬前提**，缺了它 `AVAudioSession` 设成 `.playback` 也没用，
App 一退到后台声音就停。

### 5. 打开 Xcode

```bash
npx cap open ios
```

选真机（模拟器没有锁屏控制中心，验证不了这个功能），Cmd+R 运行。

---

## 五、验证清单

跑起来后按顺序验，每一条都对应一个具体机制：

| # | 操作 | 期望 | 失败说明 |
|---|---|---|---|
| 1 | 播放歌曲，看 Xcode 控制台 | 有 `[NativeAudio] session ready {category: "AVAudioSessionCategoryPlayback", ...}` | 插件没注册上 |
| 2 | 锁屏 | 显示歌名 / 歌手 / 封面，进度条在走 | 元数据没推，或 artwork 下载失败 |
| 3 | 锁屏按暂停 | App 内 UI 同步变暂停 | `remoteCommand` 事件没回传 |
| 4 | 锁屏拖进度条 | 音频跳到对应位置 | `changePlaybackPositionCommand` 没启用 |
| 5 | 切到别的 App 放音乐 | 本 App 自动暂停 | `interruption.began` 没处理 |
| 6 | 回到本 App | 不自动抢播（除非系统建议） | `shouldResume` 判断逻辑 |
| 7 | 后台播放 5 分钟再回前台 | 锁屏进度条与 App 内进度一致 | `isAppActive` 的立即补推没生效 |
| 8 | 拔耳机 | 自动暂停 | `routeChange.oldDeviceUnavailable` 没处理 |

第 7 条是最能体现这套方案价值的一条：**没有它，锁屏进度会越走越偏**（偏差约等于后台停留时长）。

---

## 六、常见报错对照

| 报错 | 原因 | 修法 |
|---|---|---|
| `"FoliaAudioSession" plugin is not implemented on ios` | 插件没注册 | 查上面「判据 1 / 判据 2」 |
| `Unknown package 'FoliaAudioSession' in dependencies of target 'CapApp-SPM'` | Package.swift 的 `name` 不匹配 | 改成 `FoliaAudioSession` |
| `product 'FoliaAudioSession' ... not found` | `products` 里没导出同名 library | 检查 `.library(name:)` |
| `no such module 'Capacitor'` | Package.swift 缺 capacitor-swift-pm 依赖 | 补 `.package(url: ".../capacitor-swift-pm.git", from: "8.0.0")` |
| `duplicate symbol _OBJC_CLASS_$_FoliaAudioSessionPlugin` | 同时有 Swift 类和 `.m` 的 `CAP_PLUGIN` | 删掉 `.m` |
| 编译过了但后台没声音 | 缺 `UIBackgroundModes` | 补 Info.plist |
| 有声音但锁屏没信息 | `MPNowPlayingInfoCenter.nowPlayingInfo` 没设 | 确认 JS 侧调了 `updateNowPlaying` |
| 锁屏信息在切换歌曲后不更新 | 只推了 `setPlaybackState` 没推 `updateNowPlaying` | 两者都要推 |
| 进度条不动 | `playbackRate` 推的是 0 | 播放时必须是 `1.0`（或实际倍速） |

---

## 七、调试技巧

**远程调试 JS**：Safari → 开发 → <你的 iPhone> → App 的 WebView。
能直接在真机上断点看 `nativeAudioBridge` 的调用与返回值。

**看原生日志**：Xcode → Window → Devices and Simulators → 选设备 → Open Console，
过滤 `FoliaAudioSession` 或 `AVAudioSession`。

**验证会话类别是否真的生效**：在 App 内触发一次 `getAudioSessionInfo()`，
如果 `category` 不是 `AVAudioSessionCategoryPlayback`，说明 `configureAudioSession()` 没跑到或被覆盖了。
