import type { Line } from '../../../types';

// src/components/visualizer/pendolo/pendoloTimeline.ts

/** Resolves the wheel anchor when playback is outside an actively timed lyric line. */
export const resolvePendoloFallbackAnchorIndex = (
    lines: Line[],
    currentLineIndex: number,
    lastValidLineIndex: number,
    hasObservedLine: boolean,
    currentTime: number,
) => {
    if (currentLineIndex >= 0 && currentLineIndex < lines.length) {
        return currentLineIndex;
    }

    if (!hasObservedLine) {
        return -1;
    }

    // 不用 lines.at(-1)：Array.prototype.at 要 Safari 15.4+ / iOS 15.4+，
    // 而本 App 的 MinimumOSVersion 是 15.0。空数组时两者都返回 undefined，语义一致。
    const finalLine = lines[lines.length - 1];
    const finalRenderEndTime = finalLine?.renderHints?.renderEndTime ?? finalLine?.endTime;
    if (finalRenderEndTime !== undefined && currentTime > finalRenderEndTime) {
        return lines.length;
    }

    return lastValidLineIndex + 0.5;
};

const PENDOLO_VISIBLE_ARC_DEG = 110;
const PENDOLO_EDGE_FADE_DEG = 28;

/** Fades a lyric in only when its unwrapped wheel angle reaches the visible right-hand arc. */
export const resolvePendoloRotatingLineOpacity = (
    baseAngleDeg: number,
    wheelRotationDeg: number,
    baseOpacity: number,
) => {
    const visibleAngleDeg = Math.abs(baseAngleDeg + wheelRotationDeg);
    if (visibleAngleDeg >= PENDOLO_VISIBLE_ARC_DEG) return 0;
    const edgeProgress = Math.min(1, (PENDOLO_VISIBLE_ARC_DEG - visibleAngleDeg) / PENDOLO_EDGE_FADE_DEG);
    return baseOpacity * edgeProgress;
};
