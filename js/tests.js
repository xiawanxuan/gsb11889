/*
 * tests.js — 浏览器内验收测试（test.html 引用）
 * 覆盖：算法正确性 / 动态增删重排 / 间距与对齐参数 / 尺寸未就绪 /
 *       循环依赖检测 / 降级结果与算法一致。
 */
(function () {
  'use strict';
  var results = [];
  function assert(name, cond, detail) {
    results.push({ name: name, pass: !!cond, detail: detail || '' });
  }
  function near(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 0.5 : eps); }

  var A = LayoutAlgorithms;

  /* 1. 瀑布流：放入最短列、间距正确 */
  (function () {
    var sizes = [{width:100,height:100},{width:100,height:50},{width:100,height:80},{width:100,height:30}];
    var r = A.compute('masonry', sizes, { width: 210, gap: 10, columns: 2 });
    // 列宽 = (210-10)/2 = 100；item0->col0, item1->col1, item2->col1(50<100), item3->col1
    assert('masonry: 子元素放入最短列',
      near(r.positions[0].x, 0) && near(r.positions[1].x, 110) &&
      near(r.positions[2].x, 110) && near(r.positions[2].y, 60) &&
      near(r.positions[3].y, 150));
    assert('masonry: 间距生效', near(r.positions[1].x - r.positions[0].x - 100, 10));
    assert('masonry: 内容高度正确', near(r.contentHeight, 180));
  })();

  /* 2. 对齐参数 */
  (function () {
    var sizes = [{width:50,height:50},{width:50,height:50}];
    var end = A.compute('masonry', sizes, { width: 400, gap: 10, columns: 2, align: 'end' });
    var center = A.compute('masonry', sizes, { width: 400, gap: 10, columns: 2, align: 'center' });
    var colW = (400 - 10) / 2; // 显式列数时列宽仍由容器推导，内容占满 -> 偏移为 0
    assert('align: 显式列占满时偏移为 0', near(end.positions[0].x, 0) && near(center.positions[0].x, 0));
    // 用 ring 验证对齐：start 时圆心靠左
    var rs = A.compute('ring', sizes, { width: 1200, gap: 10, align: 'start' });
    var re = A.compute('ring', sizes, { width: 1200, gap: 10, align: 'end' });
    var cxs = rs.positions.reduce(function (s, p) { return s + p.x; }, 0);
    var cxe = re.positions.reduce(function (s, p) { return s + p.x; }, 0);
    assert('align: start/end 改变内容水平位置', cxe > cxs);
  })();

  /* 3. 砖墙：奇数行缩进半格且少一列 */
  (function () {
    var sizes = [];
    for (var i = 0; i < 7; i++) sizes.push({ width: 100, height: 40 });
    var r = A.compute('brick', sizes, { width: 320, gap: 10, columns: 3 });
    // 行0: 3 个 (x=0,110,220)；行1: 2 个，缩进 (100+10)/2=55
    assert('brick: 偶数行从 0 开始', near(r.positions[0].x, 0) && near(r.positions[1].x, 110));
    assert('brick: 奇数行缩进半格', near(r.positions[3].x, 55) && near(r.positions[4].x, 165));
    assert('brick: 行高累加', near(r.positions[3].y, 50));
  })();

  /* 4. 环形：等距分布 */
  (function () {
    var sizes = [];
    for (var i = 0; i < 8; i++) sizes.push({ width: 40, height: 40 });
    var r = A.compute('ring', sizes, { width: 900, gap: 10, align: 'center' });
    var cx = 450, cy = r.contentHeight / 2;
    var ds = r.positions.map(function (p) {
      return Math.hypot(p.x + 20 - cx, p.y + 20 - cy);
    });
    var spread = Math.max.apply(null, ds) - Math.min.apply(null, ds);
    assert('ring: 所有子元素到圆心等距', spread < 1e-6, 'spread=' + spread);
  })();

  /* 5. 螺旋：半径单调不减 */
  (function () {
    var sizes = [];
    for (var i = 0; i < 10; i++) sizes.push({ width: 40, height: 40 });
    var r = A.compute('spiral', sizes, { width: 900, gap: 10, align: 'center' });
    var cy = r.contentHeight / 2;
    var ok = true, prev = -1;
    r.positions.forEach(function (p) {
      var d = Math.hypot(p.x + 20 - 450, p.y + 20 - cy);
      if (prev >= 0 && d < prev - 30) ok = false; // 允许 y 方向偏移造成的误差
      prev = Math.max(prev, d);
    });
    assert('spiral: 半径整体递增', ok);
    assert('spiral: 无 NaN 坐标', r.positions.every(function (p) {
      return isFinite(p.x) && isFinite(p.y);
    }));
  })();

  /* 6. 动态增删：重算后位置数量正确且确定 */
  (function () {
    var sizes = [{width:100,height:60},{width:100,height:90}];
    var before = A.compute('masonry', sizes, { width: 210, gap: 10, columns: 2 });
    sizes.push({ width: 100, height: 30 });
    var after = A.compute('masonry', sizes, { width: 210, gap: 10, columns: 2 });
    assert('动态增删: 新增子元素后位置数组同步增长',
      before.positions.length === 2 && after.positions.length === 3);
    sizes.pop();
    var again = A.compute('masonry', sizes, { width: 210, gap: 10, columns: 2 });
    assert('动态增删: 删除后结果与之前一致（确定性）',
      JSON.stringify(again) === JSON.stringify(before));
  })();

  /* 7. 尺寸未就绪：0 高度不导致 NaN */
  (function () {
    var sizes = [{width:100,height:0},{width:100,height:0}];
    var r = A.compute('masonry', sizes, { width: 210, gap: 10, columns: 2 });
    assert('尺寸未就绪: 0 高度不产生 NaN', r.positions.every(function (p) {
      return isFinite(p.x) && isFinite(p.y);
    }));
  })();

  /* 8. 循环依赖检测（降级引擎，DOM 测试） */
  (function () {
    var box = document.createElement('div');
    box.className = 'layout-container';
    box.style.width = '400px';
    document.body.appendChild(box);
    var detected = false;
    FallbackEngine.init(box, function (evt) {
      if (evt.type === 'cycle') detected = true;
    });
    for (var i = 0; i < 4; i++) {
      var item = document.createElement('div');
      item.className = 'item';
      item.textContent = 'test';
      box.appendChild(item);
    }
    box.classList.add('cycle-sim'); // 子元素 height:120% -> 依赖容器高度
    FallbackEngine.setEnabled(true);
    FallbackEngine.flush(); // 首次：容器高度 0 -> 循环子元素按预估高度占位
    FallbackEngine.flush(); // 第二次：模拟 ResizeObserver 触发的重排，此时发散被检测
    assert('循环依赖: 不收敛布局被检测并冻结', detected);
    var h = parseFloat(box.style.height);
    assert('循环依赖: 容器高度被限制在保护上限内', h <= 20000);
    box.classList.remove('cycle-sim');
    FallbackEngine.setEnabled(false);
    box.remove();
  })();

  /* 9. 降级引擎结果与算法一致（DOM 测试） */
  (function () {
    var box = document.createElement('div');
    box.className = 'layout-container';
    box.style.width = '460px';
    box.style.setProperty('--gap', '14');
    box.style.setProperty('--columns', '3');
    document.body.appendChild(box);
    var events = [];
    FallbackEngine.init(box, function (evt) { events.push(evt); });
    var heights = [70, 120, 40, 90, 60, 110];
    heights.forEach(function (h) {
      var item = document.createElement('div');
      item.className = 'item';
      item.style.height = h + 'px';
      box.appendChild(item);
    });
    FallbackEngine.setEnabled(true);
    FallbackEngine.flush();
    var params = FallbackEngine.readParams(box);
    var kids = Array.prototype.slice.call(box.children);
    var sizes = kids.map(function (el) {
      return { width: el.offsetWidth, height: el.offsetHeight };
    });
    var expected = LayoutAlgorithms.compute('masonry', sizes, params);
    var boxRect = box.getBoundingClientRect();
    var ox = boxRect.left + box.clientLeft, oy = boxRect.top + box.clientTop;
    var maxDev = 0;
    kids.forEach(function (el, i) {
      var r = el.getBoundingClientRect();
      maxDev = Math.max(maxDev,
        Math.abs(r.left - ox - expected.positions[i].x),
        Math.abs(r.top - oy - expected.positions[i].y));
    });
    assert('降级一致性: DOM 实际位置与算法输出一致', maxDev < 2, 'maxDev=' + maxDev.toFixed(2));
    assert('降级一致性: 容器高度等于内容高度',
      near(parseFloat(box.style.height), expected.contentHeight, 1));
    // 动态增删后重排
    box.appendChild((function () { var d = document.createElement('div'); d.className = 'item'; d.style.height = '55px'; return d; })());
    FallbackEngine.flush();
    var sizes2 = Array.prototype.map.call(box.children, function (el) {
      return { width: el.offsetWidth, height: el.offsetHeight };
    });
    var expected2 = LayoutAlgorithms.compute('masonry', sizes2, FallbackEngine.readParams(box));
    var last = box.lastElementChild.getBoundingClientRect();
    var boxRect2 = box.getBoundingClientRect();
    var ox2 = boxRect2.left + box.clientLeft, oy2 = boxRect2.top + box.clientTop;
    var lastPos = expected2.positions[expected2.positions.length - 1];
    assert('动态增删: 新增子元素位置正确',
      near(last.left - ox2, lastPos.x, 2) && near(last.top - oy2, lastPos.y, 2));
    FallbackEngine.setEnabled(false);
    box.remove();
  })();

  /* 输出 */
  var passed = results.filter(function (r) { return r.pass; }).length;
  var root = document.getElementById('test-results');
  root.innerHTML = '<h2>' + passed + ' / ' + results.length + ' 通过</h2>' +
    results.map(function (r) {
      return '<div class="' + (r.pass ? 'pass' : 'fail') + '">' +
        (r.pass ? '✓' : '✗') + ' ' + r.name +
        (r.detail ? ' <small>(' + r.detail + ')</small>' : '') + '</div>';
    }).join('');
  document.title = (passed === results.length ? 'PASS' : 'FAIL') + ' - Houdini 测试';
  console.log('[tests]', passed + '/' + results.length, results);
})();
