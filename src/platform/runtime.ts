import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';

// 当前文件：统一描述 Web、Electron、Capacitor Android 与 Capacitor iOS 的运行时能力。
//
// 本文件基于 folia-sonnet 的 src/platform/runtime.ts 扩展而来，新增 ios 分支。
// 原版只区分 web / electron / capacitor-android，iOS 会被错误地归入 'web'，
// 导致 PWA 相关分支、本地音乐入口、系统栏适配全部走错路径。

export type RuntimeEnvironment = 'web' | 'electron' | 'capacitor-android' | 'capacitor-ios';

/** 所有 Capacitor 原生平台（Android + iOS）。 */
export type NativeMobileEnvironment = Extract<RuntimeEnvironment, 'capacitor-android' | 'capacitor-ios'>;

export const hasElectronBridge = (): boolean => (
  typeof window !== 'undefined'
  && Boolean((window as typeof window & { electron?: unknown }).electron)
);

/**
 * Capacitor iOS 的原生桥挂在 `window.webkit.messageHandlers.bridge` 上。
 *
 * 这是 WKWebView 独有的 API —— Android WebView 上根本不存在。
 * 所以它同时是两条结论的证据：
 *   ① 确实在原生壳里（比 Capacitor.isNativePlatform() 更底层，不依赖注入时序）；
 *   ② 确实是 iOS（Android 不可能有它）。
 * 这比看 UA 可靠得多：iPadOS 13+ 的桌面模式 UA 里连 "iPad" 都没有。
 */
const hasIosWebkitBridge = (): boolean => {
    if (typeof window === 'undefined') return false;
    const w = window as typeof window & {
        webkit?: { messageHandlers?: Record<string, unknown> };
    };
    return Boolean(w.webkit?.messageHandlers?.bridge);
};

/**
 * 是否运行在 Capacitor 原生壳里。
 *
 * 为什么不能只用 Capacitor.isNativePlatform()：
 * 它依赖 @capacitor/core 在页面早期完成原生桥注入。极少数时序下（脚本被
 * 提前执行、或原生桥尚未就绪）它会返回 false，于是 iOS 被误判成 'web' ——
 * 后果是灾难性的：enableWebAudioAnalysis 会变成 true（把 <audio> 接进
 * Web Audio，后台静音、锁屏失效），useNativeNowPlaying 里的所有 iOS 分支
 * 也会整段跳过（锁屏控制完全没有）。症状与「功能没写」一模一样，极难排查。
 */
const isNative = (): boolean => (
    Capacitor.isNativePlatform() || hasIosWebkitBridge()
);

export const isCapacitorAndroid = (): boolean => {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') return true;
    // WKWebView 的桥存在 => 一定是 iOS，绝不可能是 Android。
    // 必须排在 UA 判断之前，否则 iOS 在 UA 对不上时会被当成 Android。
    if (hasIosWebkitBridge()) return false;
    if (!isNative()) return false;
    // 兜底：原生桥在但 platform 读不到时，用 UA 判断。
    if (typeof navigator === 'undefined') return false;
    return /Android/i.test(navigator.userAgent);
};

export const isCapacitorIOS = (): boolean => {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios') return true;
    // 桥存在即可判定为 iOS，不必再看 UA（UA 在 iPadOS 桌面模式下不可靠）
    if (hasIosWebkitBridge()) return true;
    if (!isNative()) return false;
    // 兜底：原生桥在但 platform 读不到时，用 UA 判断。
    // 注意 iPadOS 13+ 的桌面模式 UA 里没有 'iPad'，要配合 maxTouchPoints。
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent;
    return /iPad|iPhone|iPod/.test(ua)
        || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
};

/** 任意 Capacitor 原生移动端（Android 或 iOS）。 */
export const isCapacitorMobile = (): boolean => isCapacitorAndroid() || isCapacitorIOS();

/**
 * 是否运行在 iOS 的 iPad 上。
 * iPadOS 布局宽度足够时应当走桌面式分栏，而不是手机单栏。
 * 在 iOS 13+ 上 iPad 默认报告自己为 Macintosh UA，因此必须依赖原生层判断，
 * 不能只靠 UA 里的 'iPad' 字样。
 */
export const isIPadOS = (): boolean => {
  if (!isCapacitorIOS()) return false;
  // iPadOS 13+ 的 Safari 桌面模式 UA 里没有 'iPad'，用 maxTouchPoints 兜底。
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
};

export const getRuntimeEnvironment = (): RuntimeEnvironment => {
  if (hasElectronBridge()) return 'electron';
  if (isCapacitorAndroid()) return 'capacitor-android';
  if (isCapacitorIOS()) return 'capacitor-ios';
  return 'web';
};

/**
 * 本地音乐导入依赖目录读取能力（File System Access / 目录选择器）。
 * 原生移动端一律不支持，入口需要隐藏。
 */
export const supportsLocalMusicImport = (): boolean => !isCapacitorMobile();

/**
 * 是否需要在 UI 里为刘海 / 灵动岛 / 底部 Home Indicator 预留安全区。
 * iOS 一定会返回 true；Android 视厂商实现而定，交给 CSS env() 处理。
 */
export const needsSafeAreaInsets = (): boolean => isCapacitorIOS() || isCapacitorAndroid();

/**
 * PWA Service Worker 只在 Web 环境注册。
 * 任一原生壳（Android / iOS）都不注册，否则会出现「壳内又装了一层 SW」的更新死循环。
 */
export const supportsServiceWorker = (): boolean => getRuntimeEnvironment() === 'web';

/**
 * 是否应该显示「刷新 / 重新加载页面」这类浏览器语义的操作。
 */
export const supportsPageReload = (): boolean => getRuntimeEnvironment() === 'web';

/** 供调试面板与日志使用的一句话环境描述。 */
export const describeRuntime = async (): Promise<string> => {
  const env = getRuntimeEnvironment();
  if (env === 'web' || env === 'electron') return env;
  try {
    const info = await Device.getInfo();
    return `${env} (${info.model}, iOS ${info.osVersion})`;
  } catch {
    return env;
  }
};
