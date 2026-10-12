import type { HexGridCoord } from './hexViewport';

// Computes and applies frame-local styles for draggable folia hex card wrappers.
export type HexCardPointerEvents = 'auto' | 'none';

export interface HexCardFrameOptions {
    clipRadius: number;
    maxDistance: number;
    lodStart: number;
    lodEnd: number;
    viewportWidth?: number;
    viewportHeight?: number;
    cardWidth?: number;
    cardHeight?: number;
    visibilityBuffer?: number;
    /**
     * 播放按钮的浮现半径（像素）。卡片中心离屏幕中心小于这个距离时才显示播放键。
     *
     * 必须由调用方按卡片尺寸传入：以前这里写死 40px，在密集封面墙
     * （瓷砖只有 116px、间距 120px）下，只要手指稍微一拖播放键就没了，
     * 而放大卡片时它又会太早出现。所以改成跟 spacing 挂钩。
     */
    playRevealRadius?: number;
}

export interface HexCardFrame {
    visible: boolean;
    display: '' | 'none';
    distance: number;
    distanceSq: number;
    transform: string;
    opacity: string;
    zIndex: string;
    queueOpacity: string;
    queuePointerEvents: HexCardPointerEvents;
    playOpacity: string;
    playScale: string;
    playPointerEvents: HexCardPointerEvents;
}

export interface HexCardFrameStyleCache {
    display?: string;
    transform?: string;
    opacity?: string;
    zIndex?: string;
    queueOpacity?: string;
    queuePointerEvents?: string;
    playOpacity?: string;
    playScale?: string;
    playPointerEvents?: string;
}

export interface HexCardStyleTarget {
    style: Pick<CSSStyleDeclaration, 'display' | 'transform' | 'opacity' | 'zIndex' | 'setProperty'>;
}

const formatNumber = (value: number, precision = 4): string => {
    if (Object.is(value, -0) || Math.abs(value) < 0.00001) return '0';
    const rounded = Number(value.toFixed(precision));
    return String(rounded);
};

const formatOpacity = (value: number): string => formatNumber(Math.max(0, Math.min(1, value)), 3);

/**
 * 缩放量化步长。
 *
 * 把缩放值吸附到 0.01 的整数倍上，卡片 transform 字符串就只在「跨档」时才变化。
 * 关键在于：放大区很小（只有 maxDistance 半径内的卡片 scale > 1，
 * 116px 瓷砖 + 192px 半径时大约只有 8 张），**其余上百张卡片的 scale 恒等于 1**，
 * transform 字符串一辈子不变 —— 拖拽期间它们的 style 一次都不会被写。
 * 这是本轮流畅度优化的主要来源。
 *
 * 步长取 0.01 是因为受影响的面很窄：0.01 × 116px ≈ 1.2px，
 * 即使快速拖拽也看不出「跳档」。
 */
const SCALE_QUANT_STEP = 0.01;

/** 封面墙：屏幕正中央那张卡片的放大倍数。 */
const WALL_CENTER_SCALE = 1.42;

/** 放大的衰减指数。越大，放大区收得越紧（只有最中心一小片被强调）。 */
const WALL_SCALE_FALLOFF = 1.6;

/**
 * 卡片位移只包含它自身的网格坐标（baseX / baseY），**不含拖拽偏移 dx / dy**。
 *
 * ⚠️ 这里绝不能再把 dx / dy 加进来。整个网格的平移由外层容器的
 * `style={{ x: dragX, y: dragY }}` 负责（见 GridView.tsx 的 <motion.div>）。
 * 如果卡片自己也叠加 dx/dy，平移会被应用两次，后果有两条：
 *   1. 拖拽速度变成手指的两倍，而且 `centerOnIndex` 用 dragX = -baseX
 *      算出来的位置根本居中不了（卡片会停在 -baseX 处）；
 *   2. 裁剪圆心在 (dx, dy)，卡片却画在 (2dx, 2dy)，两者错位 —— 拖得越远
 *      边缘空白越大，同时挂载了大量本不该存在的离屏卡片。
 * 同级组件 GridMap.tsx 就是正确写法：transform 只含 baseX/baseY。
 */
const buildTransform = (coord: HexGridCoord, scale: number): string => (
    `translate3d(${formatNumber(coord.baseX, 3)}px, ${formatNumber(coord.baseY, 3)}px, 0) scale(${formatNumber(scale)})`
);

// Resolves visual state for one card without touching React or the DOM.
export const computeHexCardFrame = (
    coord: HexGridCoord,
    dx: number,
    dy: number,
    {
        clipRadius,
        maxDistance,
        lodStart,
        lodEnd,
        viewportWidth,
        viewportHeight,
        cardWidth = 0,
        cardHeight = 0,
        visibilityBuffer = 0,
        playRevealRadius = 40,
    }: HexCardFrameOptions
): HexCardFrame => {
    const centerX = coord.baseX + dx;
    const centerY = coord.baseY + dy;
    const distanceSq = centerX * centerX + centerY * centerY;
    const distance = Math.sqrt(distanceSq);
    const visibleInRadius = distance <= clipRadius;
    const visibleInViewport = viewportWidth === undefined || viewportHeight === undefined
        ? true
        : Math.abs(centerX) <= viewportWidth / 2 + cardWidth / 2 + visibilityBuffer
            && Math.abs(centerY) <= viewportHeight / 2 + cardHeight / 2 + visibilityBuffer;
    const visible = visibleInRadius && visibleInViewport;
    const progress = Math.min(distance / Math.max(maxDistance, 1), 1);

    // 封面墙：所有卡片默认就是满尺寸（1.0），只有靠近屏幕中心的才放大。
    // 旧的「1.1 - 0.65 * progress」会让边缘卡片缩到 0.45，墙面因此变得稀疏、
    // 大小参差；参考截图里的封面墙是均匀铺满的，只有中心一张明显浮起来。
    const rawScale = visible
        ? 1 + (WALL_CENTER_SCALE - 1) * Math.pow(1 - progress, WALL_SCALE_FALLOFF)
        : 1;
    const scale = Math.round(rawScale / SCALE_QUANT_STEP) * SCALE_QUANT_STEP;

    // 密集封面墙不再按距离淡出：可见就是全不透明。
    // 离屏卡片由 display:none 直接裁掉，而硬切换发生在屏幕之外，看不到跳变。
    // （顺带也让 opacity 这个 style 值恒定，拖拽期间完全不需要写。）
    const opacity = visible ? 1 : 0;

    // zIndex 由量化后的缩放档位推导：越大越靠上，保证中心放大的卡片压住邻居。
    // 因为跟着 scale 一起量化，它同样只在跨档时变化，不会每帧写。
    const zIndex = Math.round((scale - 1) / SCALE_QUANT_STEP);

    let queueOpacity = '0';
    let queuePointerEvents: HexCardPointerEvents = 'none';
    if (distance < lodStart || lodEnd <= lodStart) {
        queueOpacity = '1';
        queuePointerEvents = 'auto';
    } else if (distance <= lodEnd) {
        const queueProgress = (distance - lodStart) / (lodEnd - lodStart);
        queueOpacity = formatOpacity(1 - queueProgress);
        queuePointerEvents = 'auto';
    }

    let playOpacity = '0';
    let playScale = '0.8';
    let playPointerEvents: HexCardPointerEvents = 'none';
    if (distance < playRevealRadius) {
        const playProgress = distance / playRevealRadius;
        playOpacity = formatOpacity(1 - playProgress);
        playScale = formatNumber(1 - 0.2 * playProgress);
        playPointerEvents = 'auto';
    }

    return {
        visible,
        display: visible ? '' : 'none',
        distance,
        distanceSq,
        transform: buildTransform(coord, scale),
        opacity: formatOpacity(opacity),
        zIndex: String(zIndex),
        queueOpacity,
        queuePointerEvents,
        playOpacity,
        playScale,
        playPointerEvents,
    };
};

export const createHexCardFrameStyleCache = (frame: HexCardFrame): HexCardFrameStyleCache => ({
    display: frame.display,
    transform: frame.transform,
    opacity: frame.opacity,
    zIndex: frame.zIndex,
    queueOpacity: frame.queueOpacity,
    queuePointerEvents: frame.queuePointerEvents,
    playOpacity: frame.playOpacity,
    playScale: frame.playScale,
    playPointerEvents: frame.playPointerEvents,
});

// Applies only changed style values so the drag rAF loop avoids redundant DOM writes.
export const applyHexCardFrameStyles = (
    target: HexCardStyleTarget,
    frame: HexCardFrame,
    cache: HexCardFrameStyleCache
): boolean => {
    let didWrite = false;
    const { style } = target;

    if (cache.display !== frame.display) {
        style.display = frame.display;
        cache.display = frame.display;
        didWrite = true;
    }

    if (!frame.visible) {
        return didWrite;
    }

    if (cache.transform !== frame.transform) {
        style.transform = frame.transform;
        cache.transform = frame.transform;
        didWrite = true;
    }

    if (cache.opacity !== frame.opacity) {
        style.opacity = frame.opacity;
        cache.opacity = frame.opacity;
        didWrite = true;
    }

    if (cache.zIndex !== frame.zIndex) {
        style.zIndex = frame.zIndex;
        cache.zIndex = frame.zIndex;
        didWrite = true;
    }

    const setCustomProperty = (
        property: string,
        cacheKey: keyof HexCardFrameStyleCache,
        value: string
    ) => {
        if (cache[cacheKey] === value) return;
        style.setProperty(property, value);
        cache[cacheKey] = value;
        didWrite = true;
    };

    setCustomProperty('--queue-opacity', 'queueOpacity', frame.queueOpacity);
    setCustomProperty('--queue-pe', 'queuePointerEvents', frame.queuePointerEvents);
    setCustomProperty('--play-opacity', 'playOpacity', frame.playOpacity);
    setCustomProperty('--play-scale', 'playScale', frame.playScale);
    setCustomProperty('--play-pe', 'playPointerEvents', frame.playPointerEvents);

    return didWrite;
};
