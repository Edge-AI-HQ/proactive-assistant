# Telegram Bot 超时配置

## 问题背景

Telegram webhook 在处理需要创建 assistant 容器的请求时会超时，因为：

1. 容器创建需要与 Fly.io API 交互
2. 支持多区域容错（最多 8 个区域）
3. 每个区域最多重试 8 次
4. 单个区域创建可能需要 10-30 秒
5. 最坏情况下总共可能需要 60-120 秒

## 解决方案

使用独立的超时配置给 Telegram bot API 调用：

### 环境变量

```env
# Telegram bot API 调用超时（默认 120 秒）
# 用于处理容器创建等耗时操作
TELEGRAM_BOT_REQUEST_TIMEOUT_MS=120000

# 其他 API 调用超时（默认 10 秒）
# 用于 Stripe webhook、订阅管理等快速操作
PAYMENT_REQUEST_TIMEOUT_MS=10000
```

### 代码实现

- `apis/src/domain/telegram-bot/client.ts` 使用 `telegramBotRequestTimeoutMs`
- 其他 payment 相关 API 使用 `requestTimeoutMs`
- 两个超时配置互不影响

## 配置到 Fly.io

```bash
# 生产环境
fly secrets set TELEGRAM_BOT_REQUEST_TIMEOUT_MS=120000 -a pinclaw-api-dev

# 如果需要调整其他 API 的超时
fly secrets set PAYMENT_REQUEST_TIMEOUT_MS=10000 -a pinclaw-api-dev
```

## 超时时间建议

### Telegram Bot API 超时

| 场景 | 推荐值 | 说明 |
|------|--------|------|
| 单区域部署 | 30000 (30秒) | 足够创建单个容器 |
| 多区域容错 (2-3 个) | 60000 (60秒) | 允许 2-3 个区域重试 |
| 多区域容错 (8 个) | 120000 (120秒) | 当前配置，支持完整的区域列表 |
| 极端情况 | 180000 (180秒) | 网络很慢或 Fly 响应慢时 |

### 其他 API 超时

| 场景 | 推荐值 | 说明 |
|------|--------|------|
| Stripe webhook | 5000 (5秒) | Stripe 要求 webhook 快速响应 |
| 订阅管理 | 10000 (10秒) | 默认值，足够大部分操作 |
| 数据库查询 | 10000 (10秒) | 包含多个查询的复杂操作 |

## 监控和调优

### 查看实际耗时

查看 Fly.io logs 中的容器创建日志：

```bash
fly logs -a pinclaw-api-dev | grep "Assistant machine"
```

示例输出：

```
Creating assistant machine for bot 123456789
Trying region cdg...
✓ Machine created in cdg after 8.2s
```

### 调整建议

1. **如果经常超时**：
   - 增加 `TELEGRAM_BOT_REQUEST_TIMEOUT_MS` 到 180000 (3分钟)
   - 检查是否所有配置的区域都可用
   - 考虑减少区域列表到 3-5 个容量最充足的

2. **如果从不超时**：
   - 可以适当降低到 90000 (90秒) 节省资源
   - 但建议保留一定余量以应对网络波动

3. **如果 Telegram 用户体验差**：
   - 考虑实现异步创建模式
   - 立即返回"创建中"状态
   - 通过 Telegram 消息通知创建完成

## 故障排查

### 问题：仍然超时

1. 检查环境变量是否正确设置：
   ```bash
   fly secrets list -a pinclaw-api-dev | grep TIMEOUT
   ```

2. 查看实际使用的超时值（从应用日志）：
   ```bash
   fly logs -a pinclaw-api-dev | grep "timed out after"
   ```

3. 检查 Fly 区域容量是否充足：
   ```bash
   node scripts/select-fly-regions.mjs
   ```

### 问题：webhook 响应慢但不超时

- 这是正常的，容器创建需要时间
- 用户会在 Telegram 中看到"思考中"的状态
- 可以添加进度提示消息改善体验

### 问题：所有区域都创建失败

- 检查 `FLY_API_TOKEN` 是否有效
- 检查 `FLY_APP_NAME` 是否正确
- 查看 Fly.io 是否有平台级故障

## 相关文档

- [Fly.io 区域选择](./scripts/README.md)
- [容器创建流程](./apis/src/domain/container/README.md)（如果存在）
