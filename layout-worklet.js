/**
 * CSS Houdini Layout Worklet —— 注册 masonry / brick / ring / spiral 四个自定义布局。
 * 通过 `display: layout(masonry)` 等触发。
 * 算法实现与 JS 降级路径共用 layout-algorithms.js，保证两条路径结果一致。
 */
import { computeLayout, normalizeParams, DEFAULTS } from './layout-algorithms.js';

const INPUT_PROPERTIES = [
  '--layout-gap',
  '--layout-align',
  '--layout-columns',
  '--layout-min-column',
  '--layout-column-size',
  '--layout-brick-size',
  '--layout-row-height',
  '--layout-radius',
  '--layout-placeholder',
];

function readParams(styleMap, constraints) {
  const number = (name, fallback) => {
    const value = parseFloat(styleMap.get(name));
    return Number.isFinite(value) ? value : fallback;
  };
  const alignRaw = String(styleMap.get('--layout-align') || '').trim();
  return normalizeParams({
    gap: number('--layout-gap', DEFAULTS.gap),
    align: ['start', 'center', 'end'].includes(alignRaw) ? alignRaw : DEFAULTS.align,
    columns: number('--layout-columns', 0),
    minColumnInlineSize: number('--layout-min-column', DEFAULTS.minColumnInlineSize),
    columnInlineSize: number('--layout-column-size', 0),
    brickInlineSize: number('--layout-brick-size', DEFAULTS.brickInlineSize),
    rowHeight: number('--layout-row-height', 0),
    radius: number('--layout-radius', 0),
    placeholderBlockSize: number('--layout-placeholder', DEFAULTS.placeholderBlockSize),
    containerInlineSize: constraints.fixedInlineSize,
  });
}

/** 重入保护：同一布局类在一次布局未结束时被再次进入，说明存在循环依赖。 */
function makeReentrancyGuard(name) {
  let active = false;
  let violations = 0;
  return {
    enter() {
      if (active) {
        violations += 1;
        throw new Error(`[${name}] 检测到布局循环依赖（重入第 ${violations} 次），已中止本次布局`);
      }
      active = true;
    },
    exit() {
      active = false;
    },
  };
}

/**
 * 生成一个布局类。
 * sizingOf(child, params) 返回测量该子元素时使用的固定 inline 尺寸（null 表示自适应）。
 */
function defineLayout(name, sizingOf) {
  const guard = makeReentrancyGuard(name);

  class HoudiniLayout {
    static get inputProperties() {
      return INPUT_PROPERTIES;
    }

    static get layoutOptions() {
      return { childDisplay: 'block', sizing: 'block-like' };
    }

    async intrinsicSizes() {
      // 由 layout() 的 autoBlockSize 决定，无需额外实现。
    }

    async layout(children, edges, constraints, styleMap) {
      guard.enter();
      try {
        const params = readParams(styleMap, constraints);
        const fixedInline = sizingOf(params);

        // 先测量所有子元素（同一 layout pass 内只允许各调用一次 layoutNextFragment）。
        const fragments = await Promise.all(children.map((child) => {
          const options = fixedInline != null ? { fixedInlineSize: fixedInline(params) } : {};
          return child.layoutNextFragment(options);
        }));

        // 尺寸未就绪（如图片未加载导致 0 高）时由 sanitizeItems 替换为占位尺寸；
        // 浏览器会在子元素固有尺寸变化后自动重新触发本布局。
        const items = fragments.map((fragment) => ({
          inlineSize: fragment.inlineSize,
          blockSize: fragment.blockSize,
        }));

        const { positions, blockSize } = computeLayout(name, items, params);

        fragments.forEach((fragment, i) => {
          const position = positions[i];
          fragment.inlineOffset = position.inlineOffset;
          fragment.blockOffset = position.blockOffset;
        });

        return { autoBlockSize: blockSize, childFragments: fragments };
      } finally {
        guard.exit();
      }
    }
  }
  return HoudiniLayout;
}

registerLayout('masonry', defineLayout('masonry', (params) => (p) => {
  const gap = p.gap;
  const columns = p.columns > 0
    ? p.columns
    : Math.max(1, Math.floor((p.containerInlineSize + gap) / (p.minColumnInlineSize + gap)));
  const stretched = (p.containerInlineSize - gap * (columns - 1)) / columns;
  return p.columnInlineSize > 0 ? Math.min(p.columnInlineSize, Math.max(stretched, 1)) : Math.max(stretched, 1);
}));

registerLayout('brick', defineLayout('brick', (params) => () => Math.max(1, params.brickInlineSize)));

registerLayout('ring', defineLayout('ring', () => null));

registerLayout('spiral', defineLayout('spiral', () => null));
