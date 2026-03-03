# TODO: OpenClaw 冷启动性能优化

更新时间：2026-03-03
状态：待执行

## 背景
在 Telegram Router 并入 APIs 后，链路功能已通，但 OpenClaw 新建机器首次启动耗时较长，影响用户体验（创建后长时间显示 `Creating/Starting`）。

## 已观测到的现象（来自实战日志与监控）
1. 镜像拉取并不慢（约 1 分钟内完成）。
2. 之后出现较长“无明显业务日志阶段”（约数分钟到近 10 分钟）。
3. 指标显示启动期高负载：
- `Load Average` 峰值明显升高。
- `CPU Utilization` 接近满载。
- `CPU Quota Balance and Throttling` 中 `throttle` 长时间偏高。
4. 最终会进入 ready，并非死锁或卡死。

## 当前结论（已确认）
1. 主要瓶颈是冷启动运行时编译与缓存构建：
- jiti 首次编译缓存。
- Node V8 compile cache 首次生成。
2. `shared-cpu-1x` 在启动期会明显被 quota throttle，放大耗时。
3. 这不是 `npm run build`，而是容器启动后的运行时编译/JIT 行为。

## TODO 列表（按优先级）
1. 创建期升配 + 就绪后降配
- 目标：把首次启动耗时显著压缩。
- 动作：机器创建时使用 `shared-cpu-2x` 或 `performance-1x`，ready 后切回低配。
- 风险：需要确认 Fly 规格切换流程与成本。

2. 缓存持久化到 volume（避免每次冷启动重编译）
- 动作：
  - `mkdir -p /app/data/cache/jiti /app/data/cache/node-compile-cache`
  - `ln -sfn /app/data/cache/jiti /tmp/jiti`
  - 设置 `NODE_COMPILE_CACHE=/app/data/cache/node-compile-cache`
- 目标：第二次及后续启动明显提速。

3. 避免不必要的 destroy+create
- 动作：优化容器生命周期策略，优先复用已有 volume。
- 目标：提高缓存命中率，减少冷启动频率。

4. 插件与启动链路保持预编译优先
- 动作：确保 `openclaw-plugins/telegram-router-proxy` 的入口继续指向 `index.js`，变更后同步更新 `.js`。
- 目标：避免在运行时额外编译 TS 插件。

5. 建立创建后预热流程
- 动作：机器创建后主动做 webhook/gateway 协议级探测，通过后再通知“可用”。
- 目标：减少用户在未就绪状态下触发 `ECONNRESET`/转发失败。

## 验收标准（建议）
1. 首次启动平均耗时下降（建议记录 P50/P90）。
2. 二次启动耗时明显低于首次。
3. 启动期 throttle 占比显著下降。
4. 用户侧“创建后长时间无响应”投诉明显减少。

## 推荐排障命令
```bash
flyctl logs -a pinclaw-api-dev -n | rg "inbound ts=|Forward failed|Forwarded successfully|ECONNRESET|Fully ready"
```

```bash
flyctl logs -a pinclaw-api-dev -i <machine_id> -n | rg "pull|Machine started|TRP_VERSION|fetch proxy patch installed|Fully ready|telegram-webhook|ECONNRESET|502"
```

```bash
flyctl metrics -a pinclaw-api-dev
```
