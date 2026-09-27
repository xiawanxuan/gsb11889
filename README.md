# CSS Houdini Layout Worklet 演示

注册 4 个自定义布局（瀑布流 / 砖墙 / 环形 / 螺旋），并提供完整的工程化降级链路。

## 运行

```bash
python3 serve.py        # 或 python3 -m http.server 8000
# 打开 http://localhost:8000 （Worklet 不能用 file:// 打开）
```

- Chromium 系浏览器：走 Houdini Worklet（`display: layout(masonry)` 等）
- 其他浏览器 / 加载失败：自动降级到 JS 手动布局，结果与 Worklet 一致

## 测试

```bash
node tests/algorithms.test.mjs     # 布局算法正确性
node tests/cycle-detector.test.mjs # 循环依赖检测
```

## 架构

| 文件 | 作用 |
| --- | --- |
| `layout-algorithms.js` | 纯布局算法，Worklet / 降级 / Worker / 测试四方共用（一致性由构造保证） |
| `layout-worklet.js` | 注册 `masonry` `brick` `ring` `spiral`，含重入保护与尺寸未就绪处理 |
| `fallback.js` | JS 降级引擎：测量 → 计算 → 绝对定位；≥150 项自动卸载到 Worker |
| `worker.js` | Web Worker 离线计算布局 |
| `cycle-detector.js` | ResizeObserver 风暴 + 布局结果振荡（ABAB）两种循环依赖检测 |
| `db.js` | IndexedDB：持久化 UI 设置与性能采样 |
| `main.js` | 编排：特性检测、加载失败处理、Mutation/Resize/PerformanceObserver |

## 验收标准对照

- **算法正确**：`tests/algorithms.test.mjs` 覆盖不重叠、列宽、错位、等半径、螺旋递增等不变量
- **动态增删重排**：MutationObserver（降级模式调度）；Houdini 模式浏览器自动重排
- **间距/对齐生效**：`--layout-gap` / `--layout-align` 自定义属性，两种模式同源
- **性能可接受**：PerformanceObserver 长任务监控 + 布局耗时采样，超帧预算自动开 Worker
- **不支持时降级**：`'layoutWorklet' in CSS` 检测，自动切换并提示
- **加载失败提示**：`addModule()` catch → 错误横幅 + 自动降级
- **循环依赖检测**：Worklet 内重入保护；主线程 RO 风暴 + 结果振荡检测
- **尺寸未就绪**：0 尺寸替换占位尺寸；就绪后 RO（降级）/ 浏览器自动（Houdini）触发重排
- **降级结果一致**：两条路径共用 `layout-algorithms.js`，测试验证幂等性
