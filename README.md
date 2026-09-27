# CSS Houdini Layout Worklet 实验室

用 CSS Houdini Layout Worklet 注册自定义布局 `display: layout(houdini)`，实现
**瀑布流 / 砖墙 / 环形 / 螺旋** 四种布局算法，并提供完整的工程化兜底：
不支持时自动降级为 JS 手动布局，且两种引擎共享同一份算法代码，保证结果一致。

## 运行

```bash
cd A
python3 -m http.server 8000
# 打开 http://localhost:8000/index.html   （演示页）
# 打开 http://localhost:8000/test.html    （验收测试页）
```

> `CSS.layoutWorklet.addModule()` 要求 http(s) 上下文，`file://` 下会加载失败
> （演示页会正确提示并降级，这本身就是验收项之一）。

## 浏览器支持

- Layout API（`CSS.layoutWorklet` / `registerLayout` / `display: layout()`）目前仅在
  Chromium 系可用，且需开启 `chrome://flags/#enable-experimental-web-platform-features`。
- Firefox / Safari 不支持 → 自动走 JS 降级引擎，功能与视觉效果一致。

## 技术栈与文件结构

| 文件 | 职责 |
| --- | --- |
| `js/layout-algorithms.js` | 共享布局算法（纯函数），worklet 与降级引擎共用，保证结果一致 |
| `js/layout-worklet.js` | Layout Worklet：`registerLayout('houdini', …)`，读取 CSS 自定义属性 |
| `js/fallback.js` | 降级引擎：绝对定位手动布局 + ResizeObserver/MutationObserver + 循环依赖检测 |
| `js/worker.js` | Web Worker：IndexedDB 持久化性能指标与界面配置、统计计算 |
| `js/main.js` | 编排：特性检测、worklet 加载、引擎切换、PerformanceObserver、一致性校验 |
| `test.html` / `js/tests.js` | 浏览器内验收测试（算法 + DOM 集成） |

## 验收标准对照

| 验收项 | 实现 |
| --- | --- |
| 各布局算法正确 | `layout-algorithms.js` 纯函数 + `test.html` 断言（最短列、半格缩进、等距圆环、递增螺旋） |
| 子元素动态增删后重排正确 | worklet 由浏览器自动触发；降级引擎用 MutationObserver + ResizeObserver 重排；演示页"随机增删"按钮 |
| 间距与对齐参数生效 | `--gap` / `--align` / `--columns` 自定义属性，两种引擎同源读取 |
| 性能可接受 | PerformanceObserver 采集布局耗时与长任务 → Worker → IndexedDB；平均耗时超 16ms 帧预算时给出"性能不足"警告 |
| 不支持时降级 | 检测 `'layoutWorklet' in CSS`，不支持/加载失败/超时均自动切换 JS 引擎并提示原因 |
| 加载失败有提示 | `addModule` 竞速 8s 超时，失败原因写入通知与状态面板 |
| 循环依赖被检测 | 降级引擎"测量→布局→复测"迭代 6 次不收敛或内容高度爆炸即冻结并告警（演示页可一键注入循环依赖） |
| 尺寸未就绪有处理 | `data-pending` 子元素以 `--estimated-height` 占位（worklet 经 `childInputProperties` 感知），就绪后自动重排，占位项有虚线高亮 |
| 降级布局结果一致 | 两种引擎共享 `layout-algorithms.js`；"校验一致性"按钮对比 DOM 实际位置与算法理论位置（容差 2px） |

## 与 CSS Grid / Flex 的差异

- **表达能力**：Grid/Flex 是规则的一维/二维流；环形、螺旋、最短列瀑布流无法用声明式
  Grid/Flex 表达，Layout Worklet 可以任意编程。
- **瀑布流**：`grid-template-rows: masonry` 长期处于实验状态；Flex 多列按列填充而非
  按最短列分配。Worklet 直接实现"最短列优先"。
- **性能**：Worklet 布局运行在浏览器布局管线内部，子元素尺寸通过
  `layoutNextFragment` 一次性获取；JS 降级需要"测量 → 计算 → 写 transform"，
  多一次布局往返（可用 PerformanceObserver 量化对比）。
- **响应式**：Grid/Flex 依赖媒体查询；Worklet 在 `layout()` 回调里直接读取容器约束
  做条件布局，天然等同容器查询。
- **兼容性**：Grid/Flex 全平台可用；Layout Worklet 目前仅 Chromium 实验性支持，
  生产环境必须配套降级方案（本项目已内置）。
