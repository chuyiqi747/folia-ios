/**
 * 卡片锚点：只需要「卡片中心相对墙面原点的偏移」。
 *
 * 刻意不依赖 HexGridCoord —— 马赛克布局用的是 MosaicTile（每张卡片位置和
 * 尺寸都不同），只要它带 baseX / baseY 就能复用这一整套变换逻辑。
 */
export interface CardAnchor {
    baseX: number;
    baseY: number;
}

/**
 * 密集封面墙的卡片视觉状态。
 *
 * 这个模块被拖拽时每一帧、每一张卡片调用一次（同屏 100+ 张），
 * 所以它被刻意拆成两半：
 *
 *   1. `computeHexCardState`  —— 只算数字、只做整数比较，**不产生任何字符串**。
 *      拖拽时绝大多数卡片的缩放/按钮状态根本不变，所以每帧只需要跑这一半。
 *   2. `materializeHexCardFrame` —— 把数字变成 CSS 字符串。只在状态真的变了
 *      （或者卡片第一次挂载）时才调用。
 *
 * 之所以要这样拆：`Number.prototype.toFixed` 和模板字符串都会分配对象，
 * 100 多张卡片 × 每帧 × 若干次分配 = 每秒几万个临时字符串，
 * 直接变成 GC 压力并拖慢主线程。旧版是无条件构建字符串再比较，
 * 等于「每帧为每张卡片都造一遍字符串」，白烧。
 */

export type HexCardPointerEvents = 'auto' | 'none';

/** 按钮透明度量化档数。50 档 ≈ 2% 一档，肉眼看不出台阶。 */
const OPACITY_RANK_STEPS = 50;

/**
 * 封面墙基础缩放：屏幕正中央那张卡片的放大倍数。
 *
 * 从 1.28 降到 1.16 —— 紧凑马赛克里卡片之间只有 4px 缝，
 * 放大太多会明显压住邻居、破坏「一整面墙」的观感。
 * 参考截图里被强调的那张也基本不放大，靠白色描边来突出。
 */
const WALL_CENTER_SCALE = 1.16;

/**
 * 缩放量化步长的「粗档」宽度（0.05 一档）。
 *
 * ⚠️ 这是「图层合并」能否成立的关键参数之一。
 *
 * 旧版是 0.01 一档（SCALE_RANK_UNIT = 100）。而中心放大是随距离**连续**衰减的，
 * 所以拖动时那一圈卡片会不停地跨档 → 每次都触发 `transform` + `zIndex` 重写。
 *
 * 改成 0.05 一档之后：跨档频率降到约 1/5，被重写的卡片数大幅减少；
 * 而 0.05 的缩放台阶在手机上肉眼几乎不可见（96px 的卡片上差 4.8px，
 * 而且是在运动过程中）。
 *
 * 故意做成「常量」而不是可调项：它同时影响 zIndex 的取值域（见下）。
 */
const SCALE_RANK_UNIT = 20;

/** 放大的衰减指数。越大，放大区收得越紧（只有最中心一小片被强调）。 */
const WALL_SCALE_FALLOFF = 1.6;

/**
 * zIndex = sizeRank * 100 + scaleRank（scaleRank 现在最多 23）。
 *
 * ⚠️ 这里刻意**让 zIndex 只由「卡片大小」和「缩放档位」决定**，
 * 不再像旧版那样细到 0.01 的缩放分辨率。
 *
 * 为什么重要：zIndex 变化会让 WebKit 重新排序合成层，而合成层重排
 * 又会阻止「把多张卡片合并进父层的一个瓦片」这个优化。
 * 跨档频率降 5 倍 + 取值域收窄，都是为了让这个属性尽量不动。
 */
export const SIZE_RANK_BASE = 100;

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
     * 必须由调用方按瓷砖尺寸传入，否则小瓷砖下手指一动播放键就没了。
     */
    playRevealRadius?: number;
}

export interface HexCardState {
    visible: boolean;
    distanceSq: number;
    distance: number;
    /** 量化后的缩放档位：20 = 1.00 倍（SCALE_RANK_UNIT）。不可见时恒为 20。 */
    scaleRank: number;
    /** 「加入队列」按钮档位：-1 = 不显示，否则 1..50（50 = 全亮）。 */
    lodRank: number;
    /** 播放键档位：-1 = 不显示，否则 1..50（50 = 全亮）。 */
    playRank: number;
    /** 播放键缩放档位：80..100。 */
    playScaleRank: number;
    zIndexValue: number;
}

export interface HexCardFrame extends HexCardState {
    display: '' | 'none';
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
    visible?: boolean;
    scaleRank?: number;
    zIndexValue?: number;
    lodRank?: number;
    playRank?: number;
    playScaleRank?: number;
}

export interface HexCardStyleTarget {
    style: Pick<CSSStyleDeclaration, 'display' | 'transform' | 'opacity' | 'zIndex' | 'setProperty'>;
    /**
     * 可选：直接拿到卡片内部的两个按钮，绕开 CSS 自定义属性。
     *
     * ⚠️ 为什么不走 CSS 变量：`style.setProperty('--x', v)` 写的是**自定义属性**，
     * WebKit 每次都要做一遍 style recalc，而且因为自定义属性是**可继承**的，
     * 还要向下失效整棵子树（哪怕子树里根本没人读这个变量）。
     * 拖拽时每帧 4~5 次这样的写入，在几十张卡片的规模下是实打实的开销。
     *
     * 直接写目标元素的 `opacity` / `transform` / `pointerEvents` 只是普通的
     * 样式属性写入，不涉及继承失效，便宜得多。
     */
    playBtn?: HTMLElement | null;
    queueBtn?: HTMLElement | null;
}

const formatNumber = (value: number, precision = 4): string => {
    if (Object.is(value, -0) || Math.abs(value) < 0.00001) return '0';
    return String(Number(value.toFixed(precision)));
};

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
 * 同级组件 GridMap.tsx(581/700) 与 ArtistGridView.tsx(923) 就是正确写法。
 *
 * ⚠️⚠️ 改用 `translate` 而不是 `translate3d(x, y, 0)` —— 这是图层合并的关键。
 *
 * `translate3d` 的第三个参数会让 WebKit **无条件**把该元素提升为独立的
 * 3D 合成层（哪怕 z 就是 0）。封面墙同屏 60~140 张卡片，就变成 60~140 个
 * 独立合成层，每帧都要逐个合成、裁剪、光栅化 —— 这正是拖拽卡顿的主因。
 *
 * `translate`（2D）不会强制图层提升。当卡片只是随父层刚性平移、
 * 自身 transform 不再变化时，WebKit 可以把它和父层**合并进同一个合成瓦片**，
 * 合成开销从「N 个图层」降到「1 个瓦片」。
 */
const buildTransform = (coord: CardAnchor, scale: number): string => (
    `translate(${formatNumber(coord.baseX, 3)}px, ${formatNumber(coord.baseY, 3)}px) scale(${formatNumber(scale)})`
);

/** 只算数字、不做任何字符串分配的快速路径。 */
export const computeHexCardState = (
    coord: CardAnchor,
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
    }: HexCardFrameOptions,
    /**
     * 这张卡片自身的基础尺寸档位（0 = 最小号），由调用方按卡片实际大小算出。
     * 封面墙里每张卡片大小不一，大的应该压住小的，靠它参与 zIndex 计算。
     * 做成独立参数而不是塞进 options：options 是每帧复用的同一个对象，
     * 每张卡片都 spread 一份会变成每帧上百次对象分配。
     */
    sizeRank = 0
): HexCardState => {
    const centerX = coord.baseX + dx;
    const centerY = coord.baseY + dy;
    const distanceSq = centerX * centerX + centerY * centerY;

    // 先做最便宜的圆内判断，圆外直接返回，连 sqrt 都省掉。
    const radiusSq = clipRadius * clipRadius;
    if (distanceSq > radiusSq) {
        return {
            visible: false,
            distanceSq,
            distance: 0,
            scaleRank: SCALE_RANK_UNIT,
            lodRank: -1,
            playRank: -1,
            playScaleRank: 80,
            zIndexValue: sizeRank * SIZE_RANK_BASE + SCALE_RANK_UNIT,
        };
    }

    const distance = Math.sqrt(distanceSq);

    let visible = true;
    if (viewportWidth !== undefined && viewportHeight !== undefined) {
        visible = Math.abs(centerX) <= viewportWidth / 2 + cardWidth / 2 + visibilityBuffer
            && Math.abs(centerY) <= viewportHeight / 2 + cardHeight / 2 + visibilityBuffer;
    }

    // 封面墙：所有卡片默认满尺寸，只有靠近屏幕中心的才放大。
    let scaleRank = SCALE_RANK_UNIT;
    if (visible && distance < maxDistance) {
        const progress = distance / maxDistance;
        const rawScale = 1 + (WALL_CENTER_SCALE - 1) * Math.pow(1 - progress, WALL_SCALE_FALLOFF);
        scaleRank = Math.round(rawScale * SCALE_RANK_UNIT);
    }

    let lodRank = -1;
    if (lodEnd <= lodStart) {
        lodRank = OPACITY_RANK_STEPS;
    } else if (distance <= lodStart) {
        lodRank = OPACITY_RANK_STEPS;
    } else if (distance < lodEnd) {
        lodRank = Math.round(OPACITY_RANK_STEPS * (1 - (distance - lodStart) / (lodEnd - lodStart)));
        if (lodRank < 1) lodRank = 1;
    }

    let playRank = -1;
    let playScaleRank = 80;
    if (distance < playRevealRadius) {
        const t = distance / playRevealRadius;
        playRank = Math.round(OPACITY_RANK_STEPS * (1 - t));
        if (playRank < 1) playRank = 1;
        playScaleRank = Math.round(100 * (1 - 0.2 * t));
    }

    return {
        visible,
        distanceSq,
        distance,
        scaleRank,
        lodRank,
        playRank,
        playScaleRank,
        // 大的卡片压住小的（sizeRank 优先），同一大小里靠中心的压靠外的。
        // 注意顺序与旧版相反 —— 旧版是 scaleRank 优先，那会让「越靠中心越靠上」
        // 盖过卡片尺寸，导致 2×2 的大卡片被 1×1 的小卡片压住一角，很突兀。
        zIndexValue: sizeRank * SIZE_RANK_BASE + scaleRank,
    };
};

const rankToOpacity = (rank: number): string => String(Number((rank / OPACITY_RANK_STEPS).toFixed(3)));

/** 把数字状态变成 CSS 字符串。只在状态变化或首次挂载时调用。 */
export const materializeHexCardFrame = (coord: CardAnchor, state: HexCardState): HexCardFrame => ({
    ...state,
    display: state.visible ? '' : 'none',
    transform: buildTransform(coord, state.scaleRank / SCALE_RANK_UNIT),
    // 密集封面墙不按距离淡出：可见就是全不透明。离屏卡片由 display:none 裁掉，
    // 硬切换发生在屏幕之外，看不到跳变。
    opacity: '1',
    zIndex: String(state.zIndexValue),
    queueOpacity: state.lodRank < 0 ? '0' : rankToOpacity(state.lodRank),
    queuePointerEvents: state.lodRank < 0 ? 'none' : 'auto',
    playOpacity: state.playRank < 0 ? '0' : rankToOpacity(state.playRank),
    playScale: String(Number((state.playScaleRank / 100).toFixed(3))),
    playPointerEvents: state.playRank < 0 ? 'none' : 'auto',
});

export const createHexCardFrameStyleCache = (frame: HexCardFrame): HexCardFrameStyleCache => ({
    visible: frame.visible,
    scaleRank: frame.scaleRank,
    zIndexValue: frame.zIndexValue,
    lodRank: frame.lodRank,
    playRank: frame.playRank,
    playScaleRank: frame.playScaleRank,
});

/**
 * 把状态写进 DOM —— **先比整数，再决定要不要造字符串**。
 *
 * ⚠️ 这里有两个刻意为之的取舍，都是为了「让图层能合并」：
 *
 * 1. **transform 与 zIndex 分开判断**。旧版把两者绑在一个条件里
 *    （`scaleRank 或 zIndexValue 变了就一起写`），结果是缩放变化时
 *    连 transform 也重写一遍、zIndex 也重排一次。而 zIndex 变化会让
 *    WebKit 重新排序合成层 —— 这是阻止图层合并的头号杀手。
 *    现在两者各自只在真正需要时写。
 *
 * 2. **只在卡片缩放档位变化时写 transform**，而档位已经从 0.01 粗化到 0.05。
 *    拖拽时只有中心放大那一圈里极少数卡片会跨档，其余几十张卡片的
 *    transform 全程一次都不写 —— 它们就能和父层合并成同一个合成瓦片。
 */
export const applyHexCardState = (
    target: HexCardStyleTarget,
    coord: CardAnchor,
    state: HexCardState,
    cache: HexCardFrameStyleCache
): boolean => {
    const { style } = target;
    let didWrite = false;

    if (cache.visible !== state.visible) {
        style.display = state.visible ? '' : 'none';
        cache.visible = state.visible;
        didWrite = true;
    }

    if (!state.visible) return didWrite;

    if (cache.scaleRank !== state.scaleRank) {
        style.transform = buildTransform(coord, state.scaleRank / SCALE_RANK_UNIT);
        cache.scaleRank = state.scaleRank;
        didWrite = true;
    }

    if (cache.zIndexValue !== state.zIndexValue) {
        style.zIndex = String(state.zIndexValue);
        cache.zIndexValue = state.zIndexValue;
        didWrite = true;
    }

    // ⚠️ 按钮显隐优先「直接写按钮元素」，CSS 自定义属性只作为回退路径。
    //
    // 为什么：`style.setProperty('--queue-opacity', v)` 写的是自定义属性，
    // WebKit 每次都要跑一遍 style recalc；更贵的是自定义属性**可继承**，
    // 于是还要向下失效整棵子树 —— 哪怕子树里没人读这个变量。
    // 拖拽时这里每帧 4~5 次这样的写入，在几十张卡片的规模下是实打实的开销。
    //
    // 直接写 `element.style.opacity` 只是普通属性写入，不触发继承失效，便宜得多。
    // ArtistGridView / GridMap 复用 PolaroidCard 时仍然只提供 style 容器，
    // 所以保留 CSS 变量回退。
    if (cache.lodRank !== state.lodRank) {
        const queueBtn = target.queueBtn;
        const opacity = state.lodRank < 0 ? '0' : rankToOpacity(state.lodRank);
        const pe: HexCardPointerEvents = state.lodRank < 0 ? 'none' : 'auto';
        if (queueBtn) {
            queueBtn.style.opacity = opacity;
            queueBtn.style.pointerEvents = pe;
        } else {
            style.setProperty('--queue-opacity', opacity);
            style.setProperty('--queue-pe', pe);
        }
        cache.lodRank = state.lodRank;
        didWrite = true;
    }

    if (cache.playRank !== state.playRank) {
        const playBtn = target.playBtn;
        const opacity = state.playRank < 0 ? '0' : rankToOpacity(state.playRank);
        const pe: HexCardPointerEvents = state.playRank < 0 ? 'none' : 'auto';
        if (playBtn) {
            playBtn.style.opacity = opacity;
            playBtn.style.pointerEvents = pe;
        } else {
            style.setProperty('--play-opacity', opacity);
            style.setProperty('--play-pe', pe);
        }
        cache.playRank = state.playRank;
        didWrite = true;
    }

    if (cache.playScaleRank !== state.playScaleRank) {
        const playBtn = target.playBtn;
        const scale = String(Number((state.playScaleRank / 100).toFixed(3)));
        if (playBtn) {
            playBtn.style.transform = `scale(${scale})`;
        } else {
            style.setProperty('--play-scale', scale);
        }
        cache.playScaleRank = state.playScaleRank;
        didWrite = true;
    }

    return didWrite;
};

/** 兼容旧签名：一次算完并物化成字符串。只用于卡片首次挂载时的初始样式。 */
export const computeHexCardFrame = (
    coord: CardAnchor,
    dx: number,
    dy: number,
    options: HexCardFrameOptions,
    sizeRank = 0
): HexCardFrame => materializeHexCardFrame(coord, computeHexCardState(coord, dx, dy, options, sizeRank));
