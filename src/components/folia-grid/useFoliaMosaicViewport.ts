import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { areIndexListsEqual } from './hexViewport';
import type { MosaicTile } from './mosaicLayout';

/**
 * 马赛克墙的视口裁剪。
 *
 * 与 useFoliaHexViewport 的差别：那边是「六边形环枚举 + 环内格子查表」，
 * 只能处理等间距的规则格子；马赛克里每张卡片的位置和尺寸都不一样，
 * 所以这里直接做**矩形相交**查询。
 *
 * 成本：每次重算要线性扫一遍全部卡片。所以只在「视口中心跨过一个粗粒度
 * 网格」时才重算（见 QUERY_GRANULARITY），而不是每帧都算 ——
 * 拖拽时每秒最多重算十几次，每次几千次比较，可以忽略。
 */
export interface UseFoliaMosaicViewportOptions {
    tiles: readonly MosaicTile[];
    /** 视口半宽 + 缓冲。必须 >= QUERY_GRANULARITY，否则快速拖拽会漏挂卡片。 */
    renderHalfWidth: number;
    renderHalfHeight: number;
    fallbackIndexRef?: RefObject<number>;
}

/**
 * 重算的粒度（px）。视口中心每移动这么多像素才重新筛选一次挂载集合。
 * 取 48 是「重算频率」与「缓冲够不够」的折中：调用方传进来的
 * renderHalfWidth 里含 80px 缓冲，比 48 大，所以不会漏。
 */
const QUERY_GRANULARITY = 48;

export const useFoliaMosaicViewport = ({
    tiles,
    renderHalfWidth,
    renderHalfHeight,
    fallbackIndexRef,
}: UseFoliaMosaicViewportOptions) => {
    const [renderedIndexes, setRenderedIndexes] = useState<number[]>([]);
    const renderedIndexesRef = useRef<number[]>([]);
    const lastQueryKeyRef = useRef('');

    useEffect(() => {
        renderedIndexesRef.current = renderedIndexes;
    }, [renderedIndexes]);

    const resolveVisible = useCallback((dx: number, dy: number): number[] => {
        const indexes: number[] = [];
        for (let i = 0; i < tiles.length; i++) {
            const tile = tiles[i];
            if (!tile) continue;
            const cx = tile.baseX + dx;
            const cy = tile.baseY + dy;
            // 卡片自身的半尺寸也算进去：大卡片（2×2）中心还在屏外时，
            // 它的边缘可能已经进屏了，不能只按中心点判断。
            if (Math.abs(cx) <= renderHalfWidth + tile.width / 2
                && Math.abs(cy) <= renderHalfHeight + tile.height / 2) {
                indexes.push(i);
            }
        }
        return indexes;
    }, [renderHalfHeight, renderHalfWidth, tiles]);

    const updateRenderedIndexesForViewport = useCallback((dx: number, dy: number, force = false) => {
        if (tiles.length === 0) {
            if (renderedIndexesRef.current.length > 0) {
                renderedIndexesRef.current = [];
                setRenderedIndexes([]);
            }
            return;
        }

        const queryKey = `${Math.floor(-dx / QUERY_GRANULARITY)}:${Math.floor(-dy / QUERY_GRANULARITY)}:${tiles.length}`;
        if (!force && queryKey === lastQueryKeyRef.current) return;

        const nextIndexes = resolveVisible(dx, dy);

        const fallbackIndex = fallbackIndexRef?.current ?? 0;
        if (nextIndexes.length === 0 && fallbackIndex >= 0 && fallbackIndex < tiles.length) {
            nextIndexes.push(fallbackIndex);
        }

        lastQueryKeyRef.current = queryKey;

        if (areIndexListsEqual(renderedIndexesRef.current, nextIndexes)) return;

        renderedIndexesRef.current = nextIndexes;
        startTransition(() => {
            setRenderedIndexes(nextIndexes);
        });
    }, [fallbackIndexRef, resolveVisible, tiles.length]);

    return useMemo(() => ({
        renderedIndexes,
        renderedIndexesRef,
        updateRenderedIndexesForViewport,
    }), [renderedIndexes, updateRenderedIndexesForViewport]);
};
