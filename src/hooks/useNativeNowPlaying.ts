import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { isCapacitorIOS } from '../platform/runtime';
import {
    activateAudioSession,
    clearNowPlaying,
    getAudioSessionInfo,
    onInterruption,
    onRemoteCommand,
    onRouteChange,
    publishNowPlaying,
    publishPlaybackState,
    publishProgress,
    type PlaybackStateValue,
    type RemoteCommandEvent,
} from '../native/nativeAudioBridge';

// ============================================================================
// folia-ios / useNativeNowPlaying.ts
//
// 把「原生音频会话 + 锁屏元数据 + 远程命令」接到 Folia 的播放状态上。
//
// 与 folia-major 已有的 useMediaSessionBridge 的关系：
//
//   useMediaSessionBridge  → navigator.mediaSession（Web 标准，iOS 也能用）
//   useNativeNowPlaying    → MPNowPlayingInfoCenter（原生，iOS 专属）
//
// 两者并行、职责不重叠：
//   - mediaSession 让 Safari / 桌面浏览器有锁屏信息（已有，保持不动）
//   - 本 hook 补上 WKWebView 里 mediaSession 覆盖不到的部分：
//       * AVAudioSession 的 .playback 类别（后台出声的前提）
//       * 进度锚点的精确控制（mediaSession 的 setPositionState 在 iOS 上更新不及时）
//       * 电话打断 / 拔耳机的原生事件
//       * 远程命令的可靠回传（WKWebView 的 action handler 在部分 iOS 版本收不到耳机线控）
//
// ⚠️ 为什么两个都要，不能只留原生：
//     如果只留原生，那么用户用 Safari 打开 Web 版时锁屏就没信息了。
//     原生插件的可用性探测保证了 Web 端走 mediaSession、iOS 壳走原生，互不干扰。
//
// ⚠️ 最重要的一点 —— 后台 JS 定时器挂起：
//     iOS 声明 UIBackgroundModes=audio 之后，声音会继续播，
//     但 WKWebView 的 setTimeout / requestAnimationFrame 会被系统挂起。
//     这意味着：
//       - 歌词滚动停住（正常的，回前台会跳回来）
//       - 我们每 1s 推送一次进度的心跳也停了
//     好在 MPNowPlayingInfoCenter 会用【最后一次推送的 elapsed + playbackRate】
//     自己插值推进度条，所以锁屏进度条仍然会正常走。
//     真正需要处理的是回前台的那一刻：必须立刻重新推送一次真实进度，
//     否则锁屏进度会与实际音频产生偏差（偏差量约等于后台停留时长）。
// ============================================================================

export interface UseNativeNowPlayingOptions {
    audioRef: RefObject<HTMLAudioElement | null>;
    /** 当前展示的歌曲，用于填充锁屏标题。null 表示没有歌曲。 */
    currentSong: {
        name: string;
        artist?: string;
        album?: string;
    } | null;
    /** 已缓存的封面地址（优先于 currentSong 自带的）。 */
    cachedCoverUrl: string | null;
    /** 播放器状态，字符串形式，与 folia 的 PlayerState 对应。 */
    playbackState: PlaybackStateValue;
    /** App 是否在前台。由 useNativeAppLifecycle 提供。 */
    isAppActive: boolean;

    // ---- 以下为回传的命令处理，全部可选，未提供的命令会被忽略 ----

    onPlay?: () => void | Promise<void>;
    onPause?: () => void;
    onTogglePlayPause?: () => void | Promise<void>;
    onNextTrack?: () => void | Promise<void>;
    onPreviousTrack?: () => void | Promise<void>;
    /** 锁屏拖动进度条，position 单位秒。 */
    onSeek?: (position: number) => void;
    /** 快进 / 快退，interval 单位秒（默认 15）。 */
    onSkip?: (deltaSeconds: number) => void;
    /**
     * 系统说「可以恢复播放」时调用。
     * 注意：不要在 shouldResume 为 false 时调用它 ——
     * 那是用户在别的 App 里主动接管了音频，抢回来很不礼貌。
     */
    onResumeAfterInterruption?: () => void | Promise<void>;
}

const PROGRESS_HEARTBEAT_MS = 1000;

export const useNativeNowPlaying = (options: UseNativeNowPlayingOptions): void => {
    const {
        audioRef,
        currentSong,
        cachedCoverUrl,
        playbackState,
        isAppActive,
        onPlay,
        onPause,
        onTogglePlayPause,
        onNextTrack,
        onPreviousTrack,
        onSeek,
        onSkip,
        onResumeAfterInterruption,
    } = options;

    // 用 ref 持有回调，避免每次渲染都重订阅原生事件监听器。
    const handlersRef = useRef(options);
    handlersRef.current = options;

    // 追踪上一次的播放状态，用于只在真正变化时才推 setPlaybackState。
    const lastPublishedStateRef = useRef<PlaybackStateValue>('none');
    // 追踪上一次推送进度的时刻，避免与心跳重复推送。
    const lastProgressAtRef = useRef(0);

    // -----------------------------------------------------------------------
    // 1. 会话激活：App 启动就配好 AVAudioSession
    // -----------------------------------------------------------------------
    useEffect(() => {
        if (!isCapacitorIOS()) return;
        void activateAudioSession();
    }, []);

    // -----------------------------------------------------------------------
    // 2. 远程命令订阅（锁屏 / 控制中心 / 耳机 / 车机）
    // -----------------------------------------------------------------------
    useEffect(() => {
        if (!isCapacitorIOS()) return;

        let disposed = false;
        const handles: Array<{ remove: () => Promise<void> }> = [];

        const dispatch = (event: RemoteCommandEvent): void => {
            if (disposed) return;
            const h = handlersRef.current;

            switch (event.command) {
                case 'play':
                    void h.onPlay?.();
                    break;
                case 'pause':
                    h.onPause?.();
                    break;
                case 'togglePlayPause':
                    void h.onTogglePlayPause?.();
                    break;
                case 'nextTrack':
                    void h.onNextTrack?.();
                    break;
                case 'previousTrack':
                    void h.onPreviousTrack?.();
                    break;
                case 'seek':
                    if (typeof event.position === 'number') {
                        h.onSeek?.(event.position);
                    }
                    break;
                case 'skipForward':
                    h.onSkip?.(event.interval ?? 15);
                    break;
                case 'skipBackward':
                    h.onSkip?.(-(event.interval ?? 15));
                    break;
                default:
                    break;
            }
        };

        void (async () => {
            const commandHandle = await onRemoteCommand(dispatch);
            if (commandHandle && !disposed) handles.push(commandHandle);

            const interruptionHandle = await onInterruption((event) => {
                if (disposed) return;
                const h = handlersRef.current;

                if (event.phase === 'began') {
                    // 打断开始，系统已经停了音频。
                    // 这里不要主动调 pause()，否则会与系统的行为打架，
                    // 也可能在恢复时产生「双 pause」的竞态。
                    // 只需要让 UI 反映暂停即可。
                    h.onPause?.();
                    return;
                }

                // 打断结束。
                // 只有系统明确说 shouldResume 才恢复。
                // wasPlaying 用于二次确认：如果打断前本来就没在播，就不该恢复。
                if (event.shouldResume && event.wasPlaying) {
                    void h.onResumeAfterInterruption?.();
                }
            });
            if (interruptionHandle && !disposed) handles.push(interruptionHandle);

            const routeHandle = await onRouteChange((event) => {
                if (disposed) return;
                // 拔耳机自动暂停。这是 Apple 推荐的默认行为，
                // 避免音乐突然从手机外放出来。
                if (event.shouldPause) {
                    handlersRef.current.onPause?.();
                }
            });
            if (routeHandle && !disposed) handles.push(routeHandle);
        })();

        return () => {
            disposed = true;
            void Promise.all(handles.map((h) => h.remove()));
        };
    }, []);

    // -----------------------------------------------------------------------
    // 3. 歌曲切换时推送完整元数据
    // -----------------------------------------------------------------------
    useEffect(() => {
        if (!isCapacitorIOS()) return;

        if (!currentSong) {
            void clearNowPlaying();
            lastPublishedStateRef.current = 'none';
            return;
        }

        const audio = audioRef.current;
        // duration 可能还没解析出来（尤其切换音源时）。给 0 是安全的：
        // 系统会显示一个没有总时长的进度条，等 loadedmetadata 事件再补。
        const duration = audio && Number.isFinite(audio.duration) ? audio.duration : 0;
        const elapsed = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;

        void publishNowPlaying({
            title: currentSong.name,
            artist: currentSong.artist ?? '',
            album: currentSong.album ?? '',
            duration,
            elapsed,
            playbackRate: playbackState === 'playing' ? 1.0 : 0.0,
            artworkUrl: cachedCoverUrl ?? undefined,
        });
    }, [audioRef, cachedCoverUrl, currentSong, playbackState]);

    // -----------------------------------------------------------------------
    // 4. 播放状态变化时推送（只在真正变化时推，减少原生调用）
    // -----------------------------------------------------------------------
    useEffect(() => {
        if (!isCapacitorIOS()) return;

        const previous = lastPublishedStateRef.current;
        // 第一次进入时即使与初始值相同也要推一次，确保原生侧状态正确。
        if (previous === playbackState) return;

        lastPublishedStateRef.current = playbackState;

        const audio = audioRef.current;
        const elapsed = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : undefined;

        void publishPlaybackState(playbackState, elapsed);
    }, [audioRef, playbackState]);

    // -----------------------------------------------------------------------
    // 5. 进度心跳 —— 只在 App 处于前台时跑
    //
    // 后台时 WKWebView 的定时器本来就会被挂起，写在这里也不会执行；
    // 显式判断 isAppActive 是为了在回到前台的瞬间立刻补一次推送，
    // 这正是修正进度偏差的关键。
    // -----------------------------------------------------------------------
    useEffect(() => {
        if (!isCapacitorIOS()) return;
        if (!currentSong) return;
        if (!isAppActive) return;

        const pushOnce = (): void => {
            const audio = audioRef.current;
            if (!audio || !Number.isFinite(audio.currentTime)) return;

            lastProgressAtRef.current = Date.now();
            publishProgress({
                elapsed: audio.currentTime,
                duration: Number.isFinite(audio.duration) ? audio.duration : undefined,
                playbackRate: audio.paused ? 0.0 : audio.playbackRate || 1.0,
            });
        };

        // ⚠️ 关键：立即推一次。
        // 从后台切回来的那一刻，锁屏进度是按「最后一次推送的 elapsed + 经过时间 × rate」
        // 估算出来的，与实际音频必然有偏差（偏差 ≈ 后台停留时长，如果期间音频没在播则更大）。
        // 这里的立即推送把锚点拉回真实值。
        pushOnce();

        // 只有在播放中才需要心跳。暂停时进度不会变，推了也没意义。
        if (playbackState !== 'playing') return;

        const timer = window.setInterval(pushOnce, PROGRESS_HEARTBEAT_MS);

        // 额外监听 seeked 事件：用户拖动进度条 / 歌词跳转后立刻同步，
        // 不用等到下一个心跳周期（否则锁屏会显示 1s 的陈旧位置）。
        const handleSeeked = (): void => {
            // 距上次推送太近就跳过，避免拖动时疯狂触发原生调用。
            if (Date.now() - lastProgressAtRef.current < 200) return;
            pushOnce();
        };

        const audio = audioRef.current;
        audio?.addEventListener('seeked', handleSeeked);

        return () => {
            window.clearInterval(timer);
            audio?.removeEventListener('seeked', handleSeeked);
        };
    }, [audioRef, currentSong, isAppActive, playbackState]);

    // -----------------------------------------------------------------------
    // 6. 首次启动时读一次会话信息，便于诊断
    //    只在开发环境输出，避免污染生产日志。
    // -----------------------------------------------------------------------
    useEffect(() => {
        if (!isCapacitorIOS()) return;
        if (!import.meta.env?.DEV) return;

        void getAudioSessionInfo().then((info) => {
            if (info) {
                console.info('[NativeAudio] session ready', info);
            } else {
                console.warn(
                    '[NativeAudio] 原生插件不可用。排查顺序：\n' +
                        '  1. node_modules/folia-audio-session 是否存在（package.json 里的 file: 依赖装上了吗）\n' +
                        '  2. ios/App/App/capacitor.config.json 的 packageClassList 是否含 FoliaAudioSessionPlugin\n' +
                        '  3. ios/App/CapApp-SPM/Package.swift 是否引用了 FoliaAudioSession\n' +
                        '  4. Info.plist 是否含 UIBackgroundModes = audio\n' +
                        '详见 native-audio/ios-plugin/README.md'
                );
            }
        });
    }, []);
};

export default useNativeNowPlaying;
