import { beforeEach, describe, expect, it, vi } from 'vitest';

const capacitorState = vi.hoisted(() => ({
  native: false,
  platform: 'web',
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => capacitorState.native,
    getPlatform: () => capacitorState.platform,
  },
}));

import {
  getRuntimeEnvironment,
  isCapacitorAndroid,
  isCapacitorIOS,
  supportsLocalMusicImport,
} from '@/platform/runtime';

// 当前文件：验证宿主识别与 Android 首版能力开关。

describe('platform runtime', () => {
  beforeEach(() => {
    capacitorState.native = false;
    capacitorState.platform = 'web';
    vi.stubGlobal('window', {});
  });

  it('recognizes a regular Web host', () => {
    expect(getRuntimeEnvironment()).toBe('web');
    expect(supportsLocalMusicImport()).toBe(true);
  });

  it('gives Electron precedence when its bridge exists', () => {
    vi.stubGlobal('window', { electron: {} });
    expect(getRuntimeEnvironment()).toBe('electron');
  });

  it('recognizes Capacitor Android and disables local music import', () => {
    capacitorState.native = true;
    capacitorState.platform = 'android';
    expect(isCapacitorAndroid()).toBe(true);
    expect(getRuntimeEnvironment()).toBe('capacitor-android');
    expect(supportsLocalMusicImport()).toBe(false);
  });

  it('does not treat a native non-Android host as Android', () => {
    capacitorState.native = true;
    capacitorState.platform = 'ios';
    expect(isCapacitorAndroid()).toBe(false);
    // 原生宿主上报 ios 就应该识别成 iOS。
    // 这里以前断言的是 'web' —— 那是旧实现的 bug：当时 iOS 识别完全依赖
    // navigator.userAgent 里出现 iPad/iPhone/iPod，一旦 UA 对不上（iPadOS 13+
    // 的桌面模式 UA 里根本没有 "iPad"），iOS 就会被误判成普通网页，
    // 于是后台播放、锁屏控制这些 iOS 专属分支会被整段跳过。
    expect(isCapacitorIOS()).toBe(true);
    expect(getRuntimeEnvironment()).toBe('capacitor-ios');
  });

  it('detects iOS from the native bridge even when Capacitor reports web', () => {
    // 兜底路径：Capacitor 的原生桥注入时机异常时会返回 web，
    // 此时靠 window.webkit.messageHandlers.bridge 仍然要认出来是 iOS。
    capacitorState.native = false;
    capacitorState.platform = 'web';
    vi.stubGlobal('window', { webkit: { messageHandlers: { bridge: {} } } });

    expect(isCapacitorIOS()).toBe(true);
    expect(getRuntimeEnvironment()).toBe('capacitor-ios');
  });

  it('stays on web when there is no native bridge at all', () => {
    capacitorState.native = false;
    capacitorState.platform = 'web';
    vi.stubGlobal('window', {});

    expect(isCapacitorIOS()).toBe(false);
    expect(getRuntimeEnvironment()).toBe('web');
  });
});
