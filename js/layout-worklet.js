/*
 * layout-worklet.js
 * CSS Houdini Layout Worklet：注册自定义布局 `display: layout(houdini)`。
 * 通过 `CSS.layoutWorklet.addModule('js/layout-worklet.js')` 加载。
 *
 * 布局算法本身来自共享模块 layout-algorithms.js（静态 import），
 * 与主线程降级引擎使用同一份代码，保证结果一致。
 *
 * 注意：Layout Worklet 需要 Chrome/Edge 并开启
 * chrome://flags/#enable-experimental-web-platform-features。
 */
import './layout-algorithms.js';

if (typeof registerLayout === 'function') {
  registerLayout('houdini', class HoudiniLayout {
    static inputProperties = [
      '--layout-mode',
      '--gap',
      '--align',
      '--columns',
      '--row-height',
      '--item-size',
      '--estimated-height'
    ];
    static childInputProperties = ['--pending'];

    async layout(children, edges, constraints, styleMap) {
      const readStr = (name, dft) => {
        const v = styleMap.get(name);
        if (!v) return dft;
        const s = v.toString().trim();
        return s || dft;
      };
      const readNum = (name, dft) => {
        const n = parseFloat(readStr(name, ''));
        return Number.isFinite(n) ? n : dft;
      };

      const params = {
        mode: readStr('--layout-mode', 'masonry'),
        gap: readNum('--gap', 12),
        align: readStr('--align', 'start'),
        columns: readNum('--columns', 0),
        rowHeight: readNum('--row-height', 120),
        itemSize: readNum('--item-size', 160),
        estimatedHeight: readNum('--estimated-height', 140),
        width: constraints.fixedInlineSize != null
          ? constraints.fixedInlineSize
          : (constraints.percentageInlineSize || 300)
      };

      // 与降级引擎一致的 inline 约束：先约束宽度再测量高度。
      const inlineW = LayoutAlgorithms.itemInlineSize(params.mode, params);

      const fragments = [];
      const sizes = [];
      for (const child of children) {
        let fragment;
        try {
          fragment = await child.layoutNextFragment({ inlineSize: inlineW });
        } catch (e) {
          // 某些引擎版本不支持约束参数，退化为无约束测量。
          fragment = await child.layoutNextFragment({});
        }
        fragments.push(fragment);

        // 子元素尺寸未就绪（--pending: 1，由 [data-pending="true"] 驱动）：
        // 使用预估高度占位，待真实尺寸就绪后浏览器会自动触发重新布局。
        let pending = false;
        try {
          pending = child.styleMap.get('--pending').toString().trim() === '1';
        } catch (e) { /* childInputProperties 不可用时忽略 */ }

        sizes.push({
          width: fragment.inlineSize || inlineW,
          height: pending || !fragment.blockSize
            ? params.estimatedHeight
            : fragment.blockSize
        });
      }

      const result = LayoutAlgorithms.compute(params.mode, sizes, params);

      for (let i = 0; i < fragments.length; i++) {
        fragments[i].inlineOffset = result.positions[i].x;
        fragments[i].blockOffset = result.positions[i].y;
      }

      return {
        autoBlockSize: Math.max(0, result.contentHeight),
        childFragments: fragments
      };
    }
  });
}
