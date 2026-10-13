import { describe, expect, it } from 'vitest';
import {
    applyHexCardState,
    computeHexCardFrame,
    computeHexCardState,
    type HexCardFrameStyleCache,
} from '../../../src/components/folia-grid/hexCardTransform';
import type { HexGridCoord } from '../../../src/components/folia-grid/hexViewport';

// Verifies GridView card-frame math and the numeric (allocation-free) style application.
const makeCoord = (baseX: number, baseY = 0): HexGridCoord => ({
    index: 0,
    cube: { x: 0, y: 0, z: 0 },
    baseX,
    baseY,
});

const options = {
    clipRadius: 500,
    maxDistance: 500,
    lodStart: 340,
    lodEnd: 385,
};

const createFakeTarget = () => {
    const writes: string[] = [];
    const values: Record<string, string> = {};
    const style: Record<string, unknown> = {
        setProperty: (name: string, value: string) => {
            values[name] = value;
            writes.push(`${name}:${value}`);
        },
    };

    for (const key of ['display', 'transform', 'opacity', 'zIndex']) {
        Object.defineProperty(style, key, {
            get: () => values[key] ?? '',
            set: (value: string) => {
                values[key] = value;
                writes.push(`${key}:${value}`);
            },
        });
    }

    return {
        target: { style } as any,
        values,
        writes,
    };
};

describe('hexCardTransform', () => {
    it('computes centered card scale, opacity, layering, and controls', () => {
        const frame = computeHexCardFrame(makeCoord(0), 0, 0, options);

        expect(frame.visible).toBe(true);
        expect(frame.display).toBe('');
        expect(frame.distance).toBe(0);
        // ⚠️ v10 起改用 2D `translate` 而不是 `translate3d(x, y, 0)`：
        // translate3d 的 z 参数（哪怕是 0）会让 WebKit 无条件把元素提升为
        // 独立 3D 合成层，同屏几十上百张卡片就成了几十上百个图层。
        // 2D translate 不会，卡片因而能和父层合并进同一个合成瓦片。
        //
        // 缩放档位也从 0.01 粗化到 0.05（SCALE_RANK_UNIT = 20）：
        // 中心放大是连续衰减的，细档位会让一圈卡片不停地跨档重写样式。
        // 1.16 经 0.05 量化后是 1.15（23/20）。
        expect(frame.transform).toBe('translate(0px, 0px) scale(1.15)');
        // zIndex = sizeRank(0) * 100 + scaleRank(23) = 23
        expect(frame.zIndex).toBe('23');
        expect(frame.queueOpacity).toBe('1');
        expect(frame.queuePointerEvents).toBe('auto');
        expect(frame.playOpacity).toBe('1');
        expect(frame.playScale).toBe('1');
        expect(frame.playPointerEvents).toBe('auto');
    });

    it('marks cards outside the clip radius as hidden', () => {
        const frame = computeHexCardFrame(makeCoord(700), 0, 0, options);

        expect(frame.visible).toBe(false);
        expect(frame.display).toBe('none');
        // opacity 恒为 1：卡片是靠 display:none 裁掉的，
        // 这样重新进入视野时不会出现「先透明再淡入」的闪一下
        expect(frame.opacity).toBe('1');
        expect(frame.queueOpacity).toBe('0');
        expect(frame.queuePointerEvents).toBe('none');
        expect(frame.playPointerEvents).toBe('none');
    });

    it('hides cards outside the rectangular viewport even when inside the radial clip', () => {
        const frame = computeHexCardFrame(makeCoord(360), 0, 0, {
            ...options,
            viewportWidth: 400,
            viewportHeight: 400,
            cardWidth: 100,
            cardHeight: 100,
            visibilityBuffer: 0,
        });

        expect(frame.distance).toBe(360);
        expect(frame.visible).toBe(false);
        expect(frame.display).toBe('none');
    });

    it('fades queue controls across the LOD band', () => {
        const frame = computeHexCardFrame(makeCoord(362.5), 0, 0, options);

        expect(frame.visible).toBe(true);
        expect(frame.queueOpacity).toBe('0.5');
        expect(frame.queuePointerEvents).toBe('auto');
        expect(frame.playOpacity).toBe('0');
        expect(frame.playPointerEvents).toBe('none');
    });

    it('lets bigger cards paint above smaller ones via sizeRank', () => {
        const small = computeHexCardState(makeCoord(0), 0, 0, options, 0);
        const large = computeHexCardState(makeCoord(0), 0, 0, options, 12);

        expect(large.zIndexValue).toBeGreaterThan(small.zIndexValue);

        // ⚠️ v10 起**刻意反转**了这条语义：现在「尺寸大」优先于「离中心近」。
        //
        // 旧版是 scaleRank * 64 + sizeRank，也就是「离中心近」压过「尺寸大」。
        // 后果在紧凑马赛克里很突兀：一张 2×2 的大封面如果稍微离中心远一点，
        // 就会被紧邻的 1×1 小封面盖住一角 —— 因为大卡片的目标是「整块可见」，
        // 被压一角比小卡片被压更难看。
        //
        // 现在改成 sizeRank * 100 + scaleRank：大卡片永远在上层，
        // 同一尺寸内部再按「离中心近者优先」排序。
        const largeOffCenter = computeHexCardState(makeCoord(200), 0, 0, options, 12);
        expect(largeOffCenter.zIndexValue).toBeGreaterThan(small.zIndexValue);
    });

    it('skips repeated DOM writes when the cached state is unchanged', () => {
        const coord = makeCoord(0);
        const state = computeHexCardState(coord, 0, 0, options);
        const cache: HexCardFrameStyleCache = {};
        const { target, writes } = createFakeTarget();

        expect(applyHexCardState(target, coord, state, cache)).toBe(true);
        const firstWriteCount = writes.length;

        expect(applyHexCardState(target, coord, state, cache)).toBe(false);
        expect(writes).toHaveLength(firstWriteCount);

        const movedState = computeHexCardState(coord, 20, 0, options);
        expect(applyHexCardState(target, coord, movedState, cache)).toBe(true);
        expect(writes.length).toBeGreaterThan(firstWriteCount);
    });

    it('does zero DOM writes while dragging a card that stays outside every effect zone', () => {
        // 这是「拖拽流畅」的核心保证：
        // 一张距离始终大于 maxDistance / lodEnd / playRevealRadius 的卡片，
        // 拖拽期间它的缩放档位、按钮档位全都不变 —— 于是每帧一次 style 都不该写。
        const coord = makeCoord(200);
        const dragOptions = {
            clipRadius: 2000,
            maxDistance: 100,
            lodStart: 80,
            lodEnd: 90,
            playRevealRadius: 40,
        };
        const cache: HexCardFrameStyleCache = {};
        const { target, writes } = createFakeTarget();

        const first = computeHexCardState(coord, 0, 0, dragOptions);
        applyHexCardState(target, coord, first, cache);
        const writesAfterMount = writes.length;

        for (let frame = 1; frame <= 60; frame++) {
            // 朝**远离中心**的方向拖，保证这张卡片始终待在
            // maxDistance / lodEnd / playRevealRadius 之外
            const dx = frame * 2;
            const state = computeHexCardState(coord, dx, 0, dragOptions);
            expect(state.distance).toBeGreaterThan(first.distance);
            expect(state.scaleRank).toBe(first.scaleRank);
            expect(state.lodRank).toBe(first.lodRank);
            expect(state.playRank).toBe(first.playRank);
            expect(applyHexCardState(target, coord, state, cache)).toBe(false);
        }

        expect(writes).toHaveLength(writesAfterMount);
    });
});
