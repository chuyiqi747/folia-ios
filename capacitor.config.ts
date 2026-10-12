import type { CapacitorConfig } from '@capacitor/cli';

// 当前文件：Folia 的 Capacitor 容器配置（Android + iOS 共用一份）。
//
// iOS 侧的三个关键点：
//   1. iosScheme 必须是 https，否则 WKWebView 会把页面当不安全上下文，
//      localStorage / IndexedDB / crypto.subtle 全部不可用。
//   2. contentInset: 'always' 让 WebView 延伸到状态栏与 Home Indicator 之下，
//      具体留白交给 CSS 的 env(safe-area-inset-*)（见 src/mobile-safe-area.css）。
//   3. Keyboard.resize = 'none'：iOS 的 WKWebView 默认就不 resize，
//      这里显式声明，键盘高度由 useNativeKeyboardInset 自己处理。
//
// 注意：StatusBar 的 overlaysWebView 只在 Android 生效，
// iOS 上该调用不受支持，所以运行时代码必须按平台分支（见 useCapacitorSystemBars.ts）。

const config: CapacitorConfig = {
  appId: 'top.izuna.foliamajor',
  appName: 'Folia',
  webDir: 'dist',
  loggingBehavior: 'debug',
  backgroundColor: '#09090b',
  server: {
    iosScheme: 'https',
    androidScheme: 'https',
    hostname: 'localhost',
    cleartext: false,
  },
  ios: {
    contentInset: 'always',
    limitsNavigationsToAppBoundDomains: false,
    scrollEnabled: true,
    preferredContentMode: 'mobile',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 900,
      backgroundColor: '#09090b',
      showSpinner: false,
      // iOS 启动图必须是 storyboard，由 @capacitor/assets 生成，
      // 见 scripts/generate-ios-assets.mjs
      iosSpinnerStyle: 'small',
    },
    StatusBar: {
      overlaysWebView: true,
      style: 'LIGHT',
      backgroundColor: '#09090b',
    },
    // 刻意不在这里配 Keyboard.resize / Keyboard.style：
    //   - @capacitor/keyboard 的 KeyboardResize / KeyboardStyle 是 TS 字符串枚举，
    //     config 里写字面量（'none' / 'DARK'）通不过 tsc（枚举是名义类型）。
    //   - 而且 iOS 的 WKWebView 本来就不会因键盘 resize，
    //     键盘高度由 useNativeKeyboardInset 在运行时通过
    //     Keyboard.setResizeMode({ mode: KeyboardResize.None }) 显式处理，
    //     放在 config 里只是重复声明。
  },
};

export default config;
