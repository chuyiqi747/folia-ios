import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { Style, StatusBar } from '@capacitor/status-bar';
import { isCapacitorAndroid, isCapacitorIOS } from '../platform/runtime';

// 当前文件：让原生系统栏跟随 Folia 明暗主题，并标记原生安全区环境。
//
// 基于 folia-sonnet 的 src/hooks/useCapacitorSystemBars.ts 扩展而来。
// 关键差异（iOS 与 Android 在 StatusBar 插件上的行为并不一致）：
//
//   Android  setOverlaysWebView({ overlay: true })  → 状态栏浮在 WebView 之上
//            setBackgroundColor(transparent)        → 由页面自己画到状态栏区域
//            setStyle(Dark | Light)                 → Dark = 深色图标（浅色背景用）
//
//   iOS      setOverlaysWebView 不受支持，调用会抛错，必须跳过；
//            setBackgroundColor 在 iOS 上被忽略；
//            真正起作用的是 Info.plist 里的 UIViewControllerBasedStatusBarAppearance
//            与 setStyle（Dark | Light，语义同上）。
//
// 所以这里必须按平台分支处理，不能共用一套调用。

const applyAndroidBar = (isDaylight: boolean): void => {
  void StatusBar.setOverlaysWebView({ overlay: true });
  void StatusBar.setBackgroundColor({ color: '#00000000' });
  void StatusBar.setStyle({ style: isDaylight ? Style.Dark : Style.Light });
};

const applyIOSBar = (isDaylight: boolean): void => {
  // iOS 上 overlay 由 capacitor.config.ts 的 ios.contentInset 与 Info.plist 决定，
  // 这里只切换前景样式；Dark = 深色文字（浅色主题），Light = 浅色文字（深色主题）。
  void StatusBar.setStyle({ style: isDaylight ? Style.Dark : Style.Light });
};

export const useCapacitorSystemBars = (isDaylight: boolean): void => {
  useEffect(() => {
    const env = Capacitor.getPlatform();
    if (!Capacitor.isNativePlatform()) return;

    document.documentElement.dataset.runtime =
      env === 'ios' ? 'capacitor-ios' : 'capacitor-android';

    // 告诉 CSS：这里需要为刘海 / 灵动岛 / Home Indicator 留出安全区。
    document.documentElement.dataset.nativeSafeArea = 'true';

    if (isCapacitorAndroid()) {
      applyAndroidBar(isDaylight);
    } else if (isCapacitorIOS()) {
      applyIOSBar(isDaylight);
    }

    return () => {
      delete document.documentElement.dataset.runtime;
      delete document.documentElement.dataset.nativeSafeArea;
    };
  }, [isDaylight]);
};

/**
 * 移动端需要跟随主题变化重新着色，集中导出给 App.tsx 使用。
 */
export const useNativeMobileSystemBars = useCapacitorSystemBars;

export default useCapacitorSystemBars;
