import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App, type AppState } from '@capacitor/app';

// ============================================================================
// folia-ios / useNativeAppLifecycle.ts
//
// iOS / Android 前后台生命周期。这个版本的重点不是「暂停」，而是
// **从后台回来时把播放器的时间轴重新对齐到音频真实位置**。
//
// 为什么必须单独处理：
//
//   iOS 在 Info.plist 声明 UIBackgroundModes=audio 之后：
//     ✅ 音频继续播（AVAudioSession 类别为 .playback）
//     ❌ WKWebView 的 setTimeout / setInterval / requestAnimationFrame 被挂起
//
//   于是产生一个诡异的中间态：
//     声音在正常走，但歌词停在后台前的那一行不动。
//     如果后台停留 3 分钟，回前台时歌词会落后 3 分钟。
//
//   这不是 bug，是 iOS 的省电机制。唯一解法是在 appStateChange → active
//   的那一刻，主动把歌词行重算一遍。本 hook 提供这个时机。
//
//   顺带一提：锁屏进度条不依赖 JS 定时器 —— MPNowPlayingInfoCenter 会用
//   「最后一次推送的 elapsed + playbackRate × 经过时间」自己插值，
//   所以进度条在后台仍然正常。回前台需要补一次真实锚点，
//   这件事由 useNativeNowPlaying 的第 5 段负责。
// ============================================================================

export interface NativeLifecycleHandlers {
    /**
     * App 回到前台。
     * ⚠️ 必须在这里重新对齐歌词 —— 这是本 hook 存在的主要理由。
     */
    onResume?: (context: { backgroundDurationMs: number }) => void;
    /**
     * App 进入后台。
     * ⚠️ 不要在这里暂停音频（iOS 会继续播）。
     * 可以降低渲染帧率、停掉可视化器以省电。
     */
    onBackground?: () => void;
    /** App 即将被系统回收，尽量落盘播放进度与队列。 */
    onTerminate?: () => void;
}

export interface NativeLifecycleState {
    /** 当前 App 是否在前台。 */
    isActive: boolean;
    /** 最近一次进入后台的时刻戳（毫秒），未进过后台则为 null。 */
    lastBackgroundAt: number | null;
    /**
     * 本次后台停留时长（毫秒）。
     * 回前台后可用于日志与「歌词偏差过大」的告警。
     */
    lastBackgroundDurationMs: number;
}

export const useNativeAppLifecycle = (
    handlers: NativeLifecycleHandlers
): NativeLifecycleState => {
    const [isActive, setIsActive] = useState(true);
    const [lastBackgroundAt, setLastBackgroundAt] = useState<number | null>(null);
    const [lastBackgroundDurationMs, setLastBackgroundDurationMs] = useState(0);

    // 用 ref 持有回调，避免父组件每次渲染传入新函数导致反复重订阅原生事件。
    const handlersRef = useRef(handlers);
    handlersRef.current = handlers;

    // 进入后台的时刻。用 ref 而非 state，因为事件回调里要读最新值，
    // 而 state 更新是异步的。
    const backgroundAtRef = useRef<number | null>(null);

    useEffect(() => {
        if (!Capacitor.isNativePlatform()) return;

        let disposed = false;
        const subscriptions: Array<{ remove: () => Promise<void> }> = [];

        const handleActive = (): void => {
            if (disposed) return;

            const backgroundAt = backgroundAtRef.current;
            const durationMs = backgroundAt ? Date.now() - backgroundAt : 0;
            backgroundAtRef.current = null;

            setIsActive(true);
            setLastBackgroundDurationMs(durationMs);

            // 传入后台停留时长，让消费者可以判断偏差是否值得打日志：
            // 低于 1s 的切换通常不需要重新对齐（视觉上看不出来）。
            handlersRef.current.onResume?.({ backgroundDurationMs: durationMs });
        };

        const handleBackground = (): void => {
            if (disposed) return;

            const now = Date.now();
            backgroundAtRef.current = now;
            setLastBackgroundAt(now);
            setIsActive(false);

            handlersRef.current.onBackground?.();
        };

        void (async () => {
            // appStateChange 在 iOS 上是最可靠的单一来源，
            // 它会同时在进入后台与回到前台时触发。
            const stateSub = await App.addListener('appStateChange', (state: AppState) => {
                if (state.isActive) handleActive();
                else handleBackground();
            });
            if (!disposed) subscriptions.push(stateSub);

            // pause / resume 在 iOS 上不一定触发（尤其配了后台音频模式时），
            // 但 Android 上更可靠，两边都挂上做兜底。
            // 由于有 disposed 与 backgroundAtRef 的幂等保护，重复触发无副作用。
            const pauseSub = await App.addListener('pause', handleBackground);
            if (!disposed) subscriptions.push(pauseSub);

            const resumeSub = await App.addListener('resume', handleActive);
            if (!disposed) subscriptions.push(resumeSub);
        })();

        return () => {
            disposed = true;
            void Promise.all(subscriptions.map((s) => s.remove()));
        };
    }, []);

    return { isActive, lastBackgroundAt, lastBackgroundDurationMs };
};

export default useNativeAppLifecycle;
