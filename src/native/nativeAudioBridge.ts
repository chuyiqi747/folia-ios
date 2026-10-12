import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

// ============================================================================
// folia-ios / nativeAudioBridge.ts
//
// 原生音频插件的 JS 封装。只做三件事：
//   1. 声明插件的类型化接口（Capacitor 的 registerPlugin）
//   2. 在没有该插件（Web / Electron / Android）时优雅降级
//   3. 提供 Promise 化的 API 与事件订阅
//
// 真正的编排逻辑在 useNativeNowPlaying.ts，这个文件保持「薄」。
// ============================================================================

export type PlaybackStateValue = 'playing' | 'paused' | 'stopped' | 'none';

export type RemoteCommandName =
    | 'play'
    | 'pause'
    | 'togglePlayPause'
    | 'nextTrack'
    | 'previousTrack'
    | 'seek'
    | 'skipForward'
    | 'skipBackward';

export interface NowPlayingUpdate {
    title: string;
    artist?: string;
    album?: string;
    duration?: number;
    elapsed?: number;
    playbackRate?: number;
    artworkUrl?: string;
}

export interface AudioSessionInfo {
    category: string;
    isOtherAudioPlaying: boolean;
    outputVolume: number;
    sampleRate: number;
}

export interface RemoteCommandEvent {
    command: RemoteCommandName;
    /** 仅 seek 命令携带，单位秒。 */
    position?: number;
    /** 仅 skipForward / skipBackward 携带，单位秒。 */
    interval?: number;
}

export interface InterruptionEvent {
    phase: 'began' | 'ended';
    /** phase === 'began' 时表示打断发生前是否在播放。 */
    wasPlaying?: boolean;
    /** phase === 'ended' 时表示系统是否建议恢复播放。 */
    shouldResume?: boolean;
}

export interface RouteChangeEvent {
    reason: 'oldDeviceUnavailable' | 'newDeviceAvailable';
    /** 拔耳机时应自动暂停，避免突然外放。 */
    shouldPause: boolean;
}

interface FoliaAudioSessionPlugin {
    activate(): Promise<{
        category: string;
        sampleRate: number;
        outputVolume: number;
    }>;
    deactivate(): Promise<void>;
    updateNowPlaying(options: NowPlayingUpdate): Promise<void>;
    setPlaybackState(options: {
        state: PlaybackStateValue;
        elapsed?: number;
    }): Promise<void>;
    updateProgress(options: {
        elapsed: number;
        duration?: number;
        playbackRate?: number;
    }): Promise<void>;
    clearNowPlaying(): Promise<void>;
    getAudioSessionInfo(): Promise<AudioSessionInfo>;

    addListener(
        eventName: 'remoteCommand',
        listener: (event: RemoteCommandEvent) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: 'interruption',
        listener: (event: InterruptionEvent) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: 'routeChange',
        listener: (event: RouteChangeEvent) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: 'artworkLoaded',
        listener: (event: { url: string }) => void
    ): Promise<PluginListenerHandle>;
}

/// Capacitor 的 registerPlugin 在原生实现不存在时会返回一个 proxy，
/// 调用任何方法都会 reject。我们用 isNativeAudioAvailable() 先探测，
/// 避免在 Web 端每帧刷错误日志。
const NativeAudioSession = registerPlugin<FoliaAudioSessionPlugin>('FoliaAudioSession');

let availabilityCache: boolean | null = null;

/**
 * 原生音频插件是否真的可用。
 *
 * 不能只看 Capacitor.getPlatform() === 'ios'：用户可能忘了把 Swift 文件
 * 加进 Xcode target，这时插件不存在，但我们仍然需要能识别出来并降级。
 * 所以这里真的发一次调用去探活，结果缓存。
 */
export const isNativeAudioAvailable = async (): Promise<boolean> => {
    if (availabilityCache !== null) return availabilityCache;

    try {
        const info = await NativeAudioSession.getAudioSessionInfo();
        // 能拿到 category 就说明插件存在且已配置会话
        availabilityCache = typeof info?.category === 'string';
    } catch {
        availabilityCache = false;
    }
    return availabilityCache;
};

/** 便于测试与热重载时重置探测缓存。 */
export const resetNativeAudioAvailability = (): void => {
    availabilityCache = null;
};

// ---------------------------------------------------------------------------
// 所有导出方法都先检查可用性，不可用则静默返回。
// 调用方不需要到处写 if，Web 端行为完全不受影响。
// ---------------------------------------------------------------------------

export const activateAudioSession = async (): Promise<void> => {
    if (!(await isNativeAudioAvailable())) return;
    try {
        await NativeAudioSession.activate();
    } catch (e) {
        console.warn('[NativeAudio] activate failed', e);
    }
};

export const deactivateAudioSession = async (): Promise<void> => {
    if (!(await isNativeAudioAvailable())) return;
    try {
        await NativeAudioSession.deactivate();
    } catch (e) {
        console.warn('[NativeAudio] deactivate failed', e);
    }
};

export const publishNowPlaying = async (update: NowPlayingUpdate): Promise<void> => {
    if (!(await isNativeAudioAvailable())) return;
    try {
        await NativeAudioSession.updateNowPlaying(update);
    } catch (e) {
        console.warn('[NativeAudio] updateNowPlaying failed', e);
    }
};

export const publishPlaybackState = async (
    state: PlaybackStateValue,
    elapsed?: number
): Promise<void> => {
    if (!(await isNativeAudioAvailable())) return;
    try {
        await NativeAudioSession.setPlaybackState({ state, elapsed });
    } catch (e) {
        console.warn('[NativeAudio] setPlaybackState failed', e);
    }
};

/**
 * 高频调用：同步进度锚点。
 * 刻意不做可用性检查的 await（改成同步读缓存），
 * 因为每秒调用一次时每次 await 探测会积累微任务开销。
 */
export const publishProgress = (options: {
    elapsed: number;
    duration?: number;
    playbackRate?: number;
}): void => {
    if (availabilityCache !== true) return;
    void NativeAudioSession.updateProgress(options).catch((e) => {
        console.warn('[NativeAudio] updateProgress failed', e);
    });
};

export const clearNowPlaying = async (): Promise<void> => {
    if (!(await isNativeAudioAvailable())) return;
    try {
        await NativeAudioSession.clearNowPlaying();
    } catch (e) {
        console.warn('[NativeAudio] clearNowPlaying failed', e);
    }
};

export const getAudioSessionInfo = async (): Promise<AudioSessionInfo | null> => {
    if (!(await isNativeAudioAvailable())) return null;
    try {
        return await NativeAudioSession.getAudioSessionInfo();
    } catch {
        return null;
    }
};

export const onRemoteCommand = async (
    listener: (event: RemoteCommandEvent) => void
): Promise<PluginListenerHandle | null> => {
    if (!(await isNativeAudioAvailable())) return null;
    return NativeAudioSession.addListener('remoteCommand', listener);
};

export const onInterruption = async (
    listener: (event: InterruptionEvent) => void
): Promise<PluginListenerHandle | null> => {
    if (!(await isNativeAudioAvailable())) return null;
    return NativeAudioSession.addListener('interruption', listener);
};

export const onRouteChange = async (
    listener: (event: RouteChangeEvent) => void
): Promise<PluginListenerHandle | null> => {
    if (!(await isNativeAudioAvailable())) return null;
    return NativeAudioSession.addListener('routeChange', listener);
};

export default NativeAudioSession;
