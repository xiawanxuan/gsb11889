import { strict as assert } from 'node:assert';
import { ResizeStormDetector, OscillationDetector, layoutSignature } from '../cycle-detector.js';

/* ResizeObserver 风暴检测 */
{
  let now = 0;
  const detector = new ResizeStormDetector({ windowMs: 1000, maxEvents: 5, now: () => now });
  for (let i = 0; i < 5; i += 1) {
    now += 50;
    assert.equal(detector.record(), false, `${i + 1} 次内不报警`);
  }
  now += 50;
  assert.equal(detector.record(), true, '窗口内超过阈值 → 检测到循环');
  // 窗口滑动后恢复
  now += 2000;
  assert.equal(detector.record(), false, '窗口滑动后不再报警');
}

/* 振荡检测：A→B→A→B */
{
  const detector = new OscillationDetector();
  assert.equal(detector.record('A'), false);
  assert.equal(detector.record('B'), false);
  assert.equal(detector.record('A'), false);
  assert.equal(detector.record('B'), true, 'ABAB 模式被检测为振荡');
  const stable = new OscillationDetector();
  for (let i = 0; i < 8; i += 1) assert.equal(stable.record('A'), false, '稳定输出不报警');
}

/* 签名生成 */
{
  const s1 = layoutSignature('masonry', { gap: 10, align: 'start', columns: 3 }, 20, 800, 1234);
  const s2 = layoutSignature('masonry', { gap: 10, align: 'start', columns: 3 }, 20, 800, 1234);
  const s3 = layoutSignature('masonry', { gap: 12, align: 'start', columns: 3 }, 20, 800, 1234);
  assert.equal(s1, s2);
  assert.notEqual(s1, s3);
}

console.log('✓ cycle-detector.test.mjs 全部通过');
