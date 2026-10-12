/**
 * 封面墙的「紧凑马赛克」布局引擎。
 *
 * 参考效果（用户给的截图，实测过）：
 *   - 底层是**均匀方格**：竖向接缝严格等距（实测 85px），横向也是同一间距；
 *   - 封面之间只有 **3~5px** 的缝 —— 整屏铺满，不是「大间距 + 漂浮卡片」；
 *   - 单张封面可以**跨格**：1×1 / 2×1 / 1×2 / 2×2，所以大小明显不一，
 *     但因为跨的是整数格，整面墙**严丝合缝、没有空洞**；
 *   - 每张封面左下角压一行小白字标题。
 *
 * 所以这里的做法是：把墙面当成无限方格，从中心向外按方形螺旋逐格扫描，
 * 每个格子要么「被前面的卡片占掉」，要么「放下一张专辑」。
 * 专辑的跨格数由 id 的哈希决定（确定性 —— 同一张专辑永远是同一个大小，
 * 不会每次重排整面墙都在抖），放不下就自动降级，保证不留空洞。
 *
 * 为什么不用「随机尺寸 + 随机位置」：那一定会产生空洞和重叠，
 * 墙面会变成一团散沙 —— 正好是上一版被否掉的原因。
 */

/** 每张专辑在墙上的落位。字段刻意与 hexCardTransform 的锚点形状兼容。 */
export interface MosaicTile {
    /** 对应 items 里的下标。 */
    index: number;
    /** 卡片**中心**相对墙面原点的偏移（px）。 */
    baseX: number;
    baseY: number;
    /** 卡片实际渲染尺寸（已扣掉缝）。 */
    width: number;
    height: number;
    /** 跨格数的派生档位，参与 zIndex：越大的卡片越靠上（但优先级低于「离中心近」）。 */
    sizeRank: number;
}

/**
 * FNV-1a —— 确定性哈希。
 *
 * 用哈希而不是 Math.random：卡片尺寸必须对同一张专辑永远稳定，
 * 否则每次重新布局整面墙都会抖一遍，看起来像 bug。
 */
export const hashUnit = (key: string): number => {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
};

/**
 * 跨格分布。
 *
 * 刻意让 1×1 占多数（58%）：参考截图里绝大多数封面都是单格，
 * 大卡片是点缀。如果大卡片占比太高，墙面会变得「一块大一块小」的稀疏感，
 * 反而不像那面墙。剩下 42% 里，2×2 只占 12%，是视觉上的重音。
 */
const pickSpan = (u: number): readonly [number, number] => {
    if (u < 0.58) return [1, 1];
    if (u < 0.74) return [2, 1];
    if (u < 0.88) return [1, 2];
    return [2, 2];
};

/** 从中心向外的方形螺旋，逐格产出格坐标。半径按需增长，不会预先铺满一个大数组。 */
function* squareSpiral(): Generator<readonly [number, number]> {
    yield [0, 0];
    for (let ring = 1; ring < 8192; ring++) {
        // 上边（左→右，不含右下角）
        for (let x = -ring; x < ring; x++) yield [x, -ring];
        // 右边（上→下）
        for (let y = -ring; y < ring; y++) yield [ring, y];
        // 下边（右→左）
        for (let x = ring; x > -ring; x--) yield [x, ring];
        // 左边（下→上）
        for (let y = ring; y > -ring; y--) yield [-ring, y];
    }
}

/**
 * 把 itemKeys 依次铺成一面马赛克墙。
 *
 * @param itemKeys 每张专辑的稳定标识（通常是 id），用来算跨格数。
 * @param cell     单格边长（px，含缝）。
 * @param gap      卡片之间的缝（px）。参考截图实测 3~5px。
 */
export const buildMosaicTiles = (
    itemKeys: readonly string[],
    cell: number,
    gap: number
): MosaicTile[] => {
    const total = itemKeys.length;
    const tiles: MosaicTile[] = new Array(total);
    if (total === 0) return tiles;

    const occupied = new Set<number>();
    // 格坐标打包成一个整数 key：偏移量足够覆盖任何现实中的专辑数量。
    const keyOf = (gx: number, gy: number): number => (gx + 32768) * 65536 + (gy + 32768);

    const fits = (gx: number, gy: number, sx: number, sy: number): boolean => {
        for (let dy = 0; dy < sy; dy++) {
            for (let dx = 0; dx < sx; dx++) {
                if (occupied.has(keyOf(gx + dx, gy + dy))) return false;
            }
        }
        return true;
    };

    let placed = 0;

    for (const [gx, gy] of squareSpiral()) {
        if (placed >= total) break;
        if (occupied.has(keyOf(gx, gy))) continue;

        const [wantSx, wantSy] = pickSpan(hashUnit(`${itemKeys[placed]}#span`));
        let sx = wantSx;
        let sy = wantSy;

        // 放不下就逐级降档（2×2 → 1×2 或 2×1 → 1×1），绝不留下空洞。
        while ((sx > 1 || sy > 1) && !fits(gx, gy, sx, sy)) {
            if (sx > 1 && sx >= sy) sx -= 1;
            else if (sy > 1) sy -= 1;
            else break;
        }
        if (!fits(gx, gy, sx, sy)) {
            sx = 1;
            sy = 1;
        }

        for (let dy = 0; dy < sy; dy++) {
            for (let dx = 0; dx < sx; dx++) {
                occupied.add(keyOf(gx + dx, gy + dy));
            }
        }

        tiles[placed] = {
            index: placed,
            // 卡片中心 = 左上格坐标 + 跨格数的一半，再乘格边长
            baseX: (gx + sx / 2) * cell,
            baseY: (gy + sy / 2) * cell,
            width: sx * cell - gap,
            height: sy * cell - gap,
            // 面积档位：1×1=0，2×1/1×2=16，2×2=48。
            // 上限压到 63 以内，保证 zIndex = scaleRank * 64 + sizeRank 不会串档。
            sizeRank: Math.min(63, (sx * sy - 1) * 16),
        };
        placed++;
    }

    return tiles;
};
