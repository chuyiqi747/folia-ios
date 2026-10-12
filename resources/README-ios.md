# iOS 图标与启动图资源说明

生成脚本：`scripts/generate-ios-assets.mjs`
源图目录：`resources/`

---

## 需要准备的三张源图

把下面三个文件放进 `resources/`，然后跑 `npm run cap:assets:ios`，
`@capacitor/assets` 会自动生成
`ios/App/App/Assets.xcassets/AppIcon.appiconset/` 的全套尺寸，
以及 `Splash.imageset/` 的浅色/深色两套启动图。

| 文件名 | 尺寸 | 格式 | 说明 |
| --- | --- | --- | --- |
| `icon.png` | 1024 × 1024 | PNG，**不透明** | App 图标。**不能有 alpha 通道**，iOS 会直接拒绝带透明的 AppIcon；也不要自己画圆角，系统会裁。 |
| `splash-light.png` | 2732 × 2732 | PNG，可透明 | 浅色主题启动图中央内容，建议只放 logo，四周留大量留白。 |
| `splash-dark.png` | 2732 × 2732 | PNG，可透明 | 深色主题同理。 |

配色沿用 folia-sonnet 的 Android 资源：
浅色背景 `#efedf8`，深色背景 `#11142b`。

---

## 为什么不能用现有的 icon.svg

folia 主仓库只有 `public/icon.svg`。`@capacitor/assets` 处理 iOS 图标时
对 SVG 支持不可靠，而且 iOS AppIcon 必须是不透明位图。
所以需要先把 SVG 导出成 1024×1024 PNG：

```bash
# 用 sharp（@capacitor/assets 自带依赖）或 rsvg-convert 转换
npx sharp-cli --input public/icon.svg --output resources/icon.png resize 1024 1024

# 或者用 Inkscape
inkscape public/icon.svg --export-type=png --export-filename=resources/icon.png \
         --export-width=1024 --export-height=1024
```

导出后**务必检查不透明**：

```bash
# 有 alpha 通道会输出 RGBA / 含 alpha 的提示
file resources/icon.png
sips -g hasAlpha resources/icon.png
# 期望：hasAlpha: no
```

如果确实带 alpha，用 sips 铺一层底色：

```bash
# 先合到指定底色
sips -s format png --padToHeightWidth 1024 1024 --padColor FFFFFF \
     resources/icon.png --out resources/icon-opaque.png
```

---

## 启动图的深色模式命名约定

`@capacitor/assets` 靠**文件名后缀**识别深色版本：

- `splash.png` → 浅色（Light）
- `splash-dark.png` → 深色（Dark）

脚本里已经按这个约定拷贝到 staging 目录，不要改名。

---

## 生成后校验

```bash
npm run cap:assets:ios
```

期望看到输出类似：

```
✔ Generating icons for ios
✔ Generating splash screens for ios
```

然后确认产物存在：

```bash
ls ios/App/App/Assets.xcassets/AppIcon.appiconset/
# 应有 AppIcon-512@2x.png 等，以及 Contents.json

ls ios/App/App/Assets.xcassets/Splash.imageset/
# 应有多个 splash-*.png，以及 Contents.json
```

---

## Xcode 侧还需要确认两点

1. **AppIcon 已绑定**：Xcode → `App` target → `General` → `App Icons and Launch Images`，
   确认 `App Icon Source` 指向 `AppIcon`，`Launch Screen File` 指向 `LaunchScreen`。
   Capacitor 生成的工程默认已配好，但如果你手动换过 storyboard 要复查。

2. **LaunchScreen.storyboard 引用的是 Splash.imageset**：
   打开 `ios/App/App/Base.lproj/LaunchScreen.storyboard`，
   里面的 `imageView` 应该绑定 `Splash` 这个 image set。
   如果启动图没生效，九成是这里断了。

---

## 可选：自定义 App 显示名与 Bundle ID

`capacitor.config.ts` 里的 `appId` / `appName` 只在 `cap add ios` 时写入
`project.pbxproj`。如果之后要改，得直接在 Xcode 里改：

- `PRODUCT_BUNDLE_IDENTIFIER` → 改成你自己的（例如 `com.yourname.folia`）
- `INFOPLIST_KEY_CFBundleDisplayName` → 桌面图标下显示的名字
