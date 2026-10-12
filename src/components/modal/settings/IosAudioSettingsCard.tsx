import React, { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw, Radio } from 'lucide-react';
import { isCapacitorIOS } from '../../../platform/runtime';
import {
    getNowPlayingDiagnostics,
    isNativeAudioAvailable,
    type NowPlayingDiagnostics,
} from '../../../native/nativeAudioBridge';

// src/components/modal/settings/IosAudioSettingsCard.tsx
//
// iOS 专属：原生音频开关 + 状态诊断。
//
// 为什么需要这个卡片：
//   「切到后台不播了」「锁屏没有播放控制」这两类问题在设备上完全看不见 ——
//   没有 Xcode 就连日志都拿不到。这个卡片把原生侧的真实状态直接摊在屏幕上，
//   截图即可定位（会话类别对不对 / 会话有没有激活 / Now Playing 有没有内容 /
//   锁屏按钮注册了几个）。

type IosAudioSettingsCardProps = {
    isDaylight: boolean;
    settingsCardClass: string;
    utilityGhostButtonClass: string;
    /** 是否允许把 <audio> 接进 Web Audio（实时频谱 / ReplayGain）。 */
    realtimeSpectrumEnabled: boolean;
    onRealtimeSpectrumChange: (enabled: boolean) => void;
};

/** 内联中英文案。i18next 缺 key 时会返回 key 本身（truthy），
 *  所以不能用 `t('x') || 'fallback'`，这里直接用函数。 */
const L = (zh: string, en: string): string => (
    typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh') ? zh : en
);

const IosAudioSettingsCard: React.FC<IosAudioSettingsCardProps> = ({
    isDaylight,
    settingsCardClass,
    utilityGhostButtonClass,
    realtimeSpectrumEnabled,
    onRealtimeSpectrumChange,
}) => {
    const [pluginAvailable, setPluginAvailable] = useState<boolean | null>(null);
    const [diagnostics, setDiagnostics] = useState<NowPlayingDiagnostics | null>(null);
    const [loading, setLoading] = useState(false);

    const toggleOffBackgroundClass = isDaylight ? 'bg-zinc-300/90' : 'bg-white/10';

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const available = await isNativeAudioAvailable();
            setPluginAvailable(available);
            setDiagnostics(available ? await getNowPlayingDiagnostics() : null);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // 非 iOS（Web / Electron / Android）不显示这个卡片
    if (!isCapacitorIOS()) {
        return null;
    }

    const row = (label: string, value: string, ok?: boolean) => (
        <div className="flex items-start justify-between gap-3 py-1">
            <div className="text-[11px] opacity-55 shrink-0" style={{ color: 'var(--text-secondary)' }}>{label}</div>
            <div
                className="text-[11px] font-mono text-right break-all"
                style={{ color: ok === undefined ? 'var(--text-primary)' : (ok ? '#22c55e' : '#f97316') }}
            >
                {value}
            </div>
        </div>
    );

    const sessionOk = diagnostics?.sessionCategory?.toLowerCase() === 'playback';
    const commandsOk = (diagnostics?.registeredCommandCount ?? 0) > 0;

    return (
        <section>
            <h3 className="text-sm font-bold uppercase tracking-wider opacity-50 mb-4 flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                <Radio size={14} /> {L('iOS 原生音频', 'iOS Native Audio')}
            </h3>

            <div className={`rounded-xl border overflow-hidden ${settingsCardClass}`}>
                {/* 实时频谱开关 */}
                <div className="p-4 flex items-start justify-between gap-4">
                    <div className="space-y-1">
                        <div className="text-sm font-medium flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                            <Activity size={14} />
                            {L('实时频谱（跟随音乐律动）', 'Realtime spectrum')}
                        </div>
                        <div className="text-[11px] opacity-50 max-w-[420px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                            {L(
                                '开启后可视化器会跟随真实音频频谱律动，代价是音频要被接进 Web Audio —— iOS 在后台会挂起它，可能导致「切到后台就没声音」「锁屏不出现播放控制」。默认关闭。改完需要重新播放一首歌才生效。',
                                'Turning this on makes the visualizer react to the real audio spectrum. The cost: audio is routed through Web Audio, which iOS suspends in the background — that can stop background playback and the lock-screen player. Off by default. Takes effect on the next track.'
                            )}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => onRealtimeSpectrumChange(!realtimeSpectrumEnabled)}
                        className={`w-12 h-6 rounded-full p-1 transition-colors shrink-0 ${realtimeSpectrumEnabled ? 'bg-orange-500' : toggleOffBackgroundClass}`}
                        aria-pressed={realtimeSpectrumEnabled}
                    >
                        <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${realtimeSpectrumEnabled ? 'translate-x-6' : 'translate-x-0'}`} />
                    </button>
                </div>

                {/* 诊断 */}
                <div className="p-4 space-y-1 border-t" style={{ borderColor: 'var(--border-primary, rgba(255,255,255,0.06))' }}>
                    <div className="flex items-center justify-between gap-3 mb-2">
                        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {L('原生音频状态', 'Native audio status')}
                        </div>
                        <button
                            type="button"
                            onClick={() => void refresh()}
                            disabled={loading}
                            className={`shrink-0 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${utilityGhostButtonClass} disabled:opacity-45`}
                            style={{ color: 'var(--text-primary)' }}
                        >
                            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                            <span>{L('刷新', 'Refresh')}</span>
                        </button>
                    </div>

                    {pluginAvailable === false && (
                        <div className="text-[11px] leading-relaxed" style={{ color: '#f97316' }}>
                            {L(
                                '原生插件未加载 —— 后台播放与锁屏控制都不会生效。请把这张截图发给我。',
                                'Native plugin not loaded — background playback and lock-screen controls cannot work. Please send me a screenshot of this.'
                            )}
                        </div>
                    )}

                    {row(L('原生插件', 'Native plugin'), pluginAvailable === null ? '…' : (pluginAvailable ? 'OK' : 'NOT LOADED'), pluginAvailable === true)}
                    {row(L('会话类别', 'Session category'), diagnostics?.sessionCategory ?? '—', sessionOk)}
                    {row(L('会话已激活', 'Session active'), diagnostics ? String(diagnostics.sessionActive) : '—', diagnostics?.sessionActive)}
                    {row(L('锁屏按钮注册数', 'Remote commands'), diagnostics ? String(diagnostics.registeredCommandCount) : '—', commandsOk)}
                    {row(L('Now Playing 有内容', 'Has now-playing info'), diagnostics ? String(diagnostics.hasNowPlayingInfo) : '—')}
                    {row(L('系统播放状态', 'System playback state'), diagnostics?.playbackState ?? '—')}
                    {row(L('当前标题', 'Title'), diagnostics?.title || '—')}
                    {row(L('进度 / 时长', 'Elapsed / duration'), diagnostics ? `${diagnostics.elapsed.toFixed(1)} / ${diagnostics.duration.toFixed(1)}` : '—')}

                    <div className="text-[11px] opacity-45 pt-2 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                        {L(
                            '正常状态：原生插件 OK、会话类别 Playback、会话已激活 true、锁屏按钮注册数 8、播放时 Now Playing 有内容 true。任何一项不对，把这张截图发我。',
                            'Healthy: plugin OK, category Playback, session active true, 8 remote commands, has now-playing info true while playing. If any of these differ, send me a screenshot.'
                        )}
                    </div>
                </div>
            </div>
        </section>
    );
};

export default IosAudioSettingsCard;
