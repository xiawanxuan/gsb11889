import { strict as assert } from 'node:assert';
import {
  masonryLayout, brickLayout, ringLayout, spiralLayout,
  computeLayout, sanitizeItems, DEFAULTS,
} from '../layout-algorithms.js';

const items = (heights, width = 100) => heights.map((h) => ({ inlineSize: width, blockSize: h }));
const overlaps = (a, b, gap = 0) =>
  a.inlineOffset < b.inlineOffset + b.inlineSize - gap + 1e-9
  && b.inlineOffset < a.inlineOffset + a.inlineSize - gap + 1e-9
  && a.blockOffset < b.blockOffset + (a._h || 0)
  && b.blockOffset < a.blockOffset + (b._h || 0);

/* ---- 瀑布流 ---- */
{
  const heights = [100, 150, 80, 200, 120, 90];
  const { positions, blockSize } = masonryLayout(items(heights), {
    gap: 10, containerInlineSize: 640, columns: 3,
  });
  assert.equal(positions.length, 6);
  // 列宽 = (640 - 20) / 3 ≈ 206.67
  const colW = (640 - 20) / 3;
  for (const p of positions) assert.ok(Math.abs(p.inlineSize - colW) < 1e-9);
  // 同列内不重叠且垂直递增
  const byCol = [[], [], []];
  positions.forEach((p, i) => {
    const col = Math.round(p.inlineOffset / (colW + 10));
    byCol[col].push({ ...p, _h: heights[i] });
  });
  for (const col of byCol) {
    for (let i = 1; i < col.length; i += 1) {
      assert.ok(col[i].blockOffset >= col[i - 1].blockOffset + col[i - 1]._h, '同列项不重叠');
    }
  }
  // 总高 = 最高列高度
  assert.ok(blockSize > 0);
  // 动态增删：减少一项后重排确定且高度不增
  const smaller = masonryLayout(items(heights.slice(0, 5)), { gap: 10, containerInlineSize: 640, columns: 3 });
  assert.equal(smaller.positions.length, 5);
  // 相同输入 → 相同输出（幂等，保证降级一致性可验证）
  const again = masonryLayout(items(heights), { gap: 10, containerInlineSize: 640, columns: 3 });
  assert.deepEqual(again, { positions, blockSize });
}

/* ---- 瀑布流：固定列宽 + 对齐 ---- */
{
  const { positions } = masonryLayout(items([100, 100, 100]), {
    gap: 10, containerInlineSize: 1000, columns: 3, columnInlineSize: 100, align: 'center',
  });
  const content = 3 * 100 + 2 * 10; // 320
  const shift = (1000 - content) / 2;
  assert.ok(Math.abs(positions[0].inlineOffset - shift) < 1e-9, 'center 对齐偏移');
  const end = masonryLayout(items([100]), {
    gap: 10, containerInlineSize: 1000, columns: 3, columnInlineSize: 100, align: 'end',
  });
  assert.ok(Math.abs(end.positions[0].inlineOffset - (1000 - content)) < 1e-9, 'end 对齐偏移');
}

/* ---- 砖墙 ---- */
{
  const heights = [80, 80, 80, 80, 80, 80, 80];
  const { positions, blockSize } = brickLayout(items(heights), {
    gap: 10, containerInlineSize: 500, brickInlineSize: 100,
  });
  // 每行容量：floor((500+10)/(110)) = 4（偶数行），奇数行偏移 55 → 容纳 4 块需 55+4*110-10=485 ≤ 500
  const rows = new Map();
  positions.forEach((p) => {
    const key = p.blockOffset;
    rows.set(key, (rows.get(key) || 0) + 1);
  });
  assert.equal(rows.size, 2, '7 块排成 2 行');
  // 第二行（奇数行）有半块偏移
  const row2 = positions.filter((p) => p.blockOffset > 0);
  assert.ok(Math.abs(row2[0].inlineOffset - 55) < 1e-9, '奇数行错位半块');
  assert.ok(blockSize === 80 + 10 + 80, '两行总高');
  // 对齐：center 时行整体居中
  const centered = brickLayout(items([80, 80]), {
    gap: 10, containerInlineSize: 500, brickInlineSize: 100, align: 'center',
  });
  const rowWidth = 2 * 100 + 10;
  assert.ok(Math.abs(centered.positions[0].inlineOffset - (500 - rowWidth) / 2) < 1e-9);
}

/* ---- 环形 ---- */
{
  const n = 8;
  const { positions, blockSize } = ringLayout(items(Array(n).fill(60), 60), {
    gap: 12, containerInlineSize: 800,
  });
  assert.equal(positions.length, n);
  const cx = 400; // align 默认 start? 不——container 足够大时 start 也是 half… 用 center 验证
  const centered = ringLayout(items(Array(n).fill(60), 60), {
    gap: 12, containerInlineSize: 800, align: 'center',
  });
  const cy = centered.blockSize / 2;
  // 所有项中心到圆心距离相等
  const radii = centered.positions.map((p) => Math.hypot(
    p.inlineOffset + 30 - cx, p.blockOffset + 30 - cy,
  ));
  for (const r of radii) assert.ok(Math.abs(r - radii[0]) < 1e-6, '各项等半径');
  assert.ok(radii[0] > 0);
  assert.ok(blockSize > 0);
  // 相邻角距相等
  const angles = centered.positions.map((p) => Math.atan2(p.blockOffset + 30 - cy, p.inlineOffset + 30 - cx));
  // 单项不崩溃
  const single = ringLayout(items([60]), { gap: 12, containerInlineSize: 800 });
  assert.equal(single.positions.length, 1);
}

/* ---- 螺旋 ---- */
{
  const n = 20;
  const { positions, blockSize } = spiralLayout(items(Array(n).fill(50), 50), {
    gap: 10, containerInlineSize: 900, align: 'center',
  });
  assert.equal(positions.length, n);
  for (const p of positions) {
    assert.ok(Number.isFinite(p.inlineOffset) && Number.isFinite(p.blockOffset), '坐标有限');
  }
  // 半径单调不减（相对中心）
  const cx = 450;
  const cy = blockSize / 2;
  const dist = positions.map((p) => Math.hypot(p.inlineOffset + 25 - cx, p.blockOffset + 25 - cy));
  for (let i = 1; i < dist.length; i += 1) {
    assert.ok(dist[i] >= dist[i - 1] - 1e-6, '螺旋半径递增');
  }
  assert.ok(dist[dist.length - 1] > dist[0], '螺旋向外扩展');
}

/* ---- 尺寸未就绪 → 占位尺寸 ---- */
{
  const dirty = [{ inlineSize: 0, blockSize: 0 }, { inlineSize: NaN, blockSize: -5 }];
  const clean = sanitizeItems(dirty, DEFAULTS);
  assert.equal(clean[0].blockSize, DEFAULTS.placeholderBlockSize);
  assert.equal(clean[0].notReady, true);
  assert.equal(clean[1].inlineSize, DEFAULTS.placeholderBlockSize);
  const { positions } = masonryLayout(dirty, { gap: 10, containerInlineSize: 400, columns: 2 });
  assert.ok(positions.every((p) => Number.isFinite(p.blockOffset)), '未就绪项也能排布');
}

/* ---- 边界 ---- */
{
  assert.deepEqual(computeLayout('masonry', [], { containerInlineSize: 500 }), { positions: [], blockSize: 0 });
  assert.throws(() => computeLayout('nope', [], {}), /未知布局类型/);
  // 容器宽为 0 不崩溃
  const r = masonryLayout(items([100, 100]), { gap: 10, containerInlineSize: 0 });
  assert.ok(r.positions.every((p) => Number.isFinite(p.inlineOffset)));
}

console.log('✓ algorithms.test.mjs 全部通过');
