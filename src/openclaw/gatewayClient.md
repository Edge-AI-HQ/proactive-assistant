# GatewayClient 接口说明

## 1. 作用
`GatewayClient` 是一个轻量的 WebSocket RPC 客户端，负责和 OpenClaw Gateway 建立长连接并调用 RPC 方法。

在当前项目中，它主要用于：
- 发起 `connect` 握手
- 调用 `chat.send` / `chat.abort` 等网关方法
- 订阅 `chat` / `agent` / `cron` 等事件
- 在断线时自动重连并清理挂起请求

实现文件：`src/openclaw/gatewayClient.ts`

## 2. 协议模型
客户端按网关协议收发三类帧：

- `req`: 请求帧
  - 结构：`{ type: "req", id, method, params }`
- `res`: 响应帧
  - 结构：`{ type: "res", id, ok, payload|error }`
- `event`: 事件帧
  - 结构：`{ type: "event", event, payload, seq? }`

特殊事件：
- `connect.challenge`: 收到后触发 `sendConnect()`，完成正式握手。

## 3. GatewayClientOptions
构造参数（`new GatewayClient(opts)`）：

- 连接与认证
  - `url: string`（必填）
  - `token?: string`
  - `password?: string`
- 客户端身份
  - `role?: string`（默认 `operator`）
  - `scopes?: string[]`（默认 `['operator.admin']`）
  - `clientName?`, `clientVersion?`, `platform?`, `mode?`
  - `caps?`, `commands?`, `permissions?`
  - `userAgent?`, `locale?`
- 回调
  - `onHello?`
  - `onClose?`
  - `onEvent?`
  - `onGap?`（事件序号出现 gap 时触发）
  - `onConnectError?`
  - `onStateChange?`（`idle|connecting|connected|reconnecting|stopped`）
- 时序配置
  - `connectDelayMs?`（默认 750ms）
  - `connectTimeoutMs?`（默认 12000ms）
  - `requestTimeoutMs?`（默认 60000ms）
  - `initialBackoffMs?`（默认 1000ms）
  - `maxBackoffMs?`（默认 30000ms）

## 4. 对外接口

### `start(): void`
启动连接流程：
1. 状态切到 `connecting`
2. 建立 WebSocket
3. 连接成功后发送 `connect` 请求

### `stop(): void`
主动关闭并停止自动重连：
- 清理连接/重连定时器
- 关闭 socket
- reject 所有 pending 请求
- 清空 hello waiter

### `get connected(): boolean`
当前是否已建立 WebSocket（`OPEN` 状态）。

### `waitForHello(timeoutMs = 12000): Promise<JsonObject>`
等待握手完成（`connect` 成功）。
- 已握手：立即返回 hello payload
- 断连：抛出 `gateway disconnected`/`gateway client stopped`
- 超时：抛出 `gateway connect timeout`

### `request<T>(method, params?, opts?): Promise<T>`
发送 RPC 请求。

- 参数
  - `method: string`
  - `params: Record<string, unknown> = {}`
  - `opts?: { expectFinal?: boolean; timeoutMs?: number; signal?: AbortSignal }`
- 行为
  - 自动生成请求 id
  - 按请求级 timeout 管理 pending
  - 支持 `AbortSignal`
  - `expectFinal=true` 时会忽略 `payload.status === 'accepted'` 的 ack，继续等待最终响应

## 5. 生命周期与重连

- 断线后自动指数退避重连：`initialBackoffMs -> ... -> maxBackoffMs`
- 重连期间状态会进入 `reconnecting`
- 重新连接并成功握手后，退避时间重置回初始值
- `stop()` 后不会继续重连

## 6. 错误语义（常见）

- 连接前请求：`gateway not connected`
- 连接握手超时：`gateway connect timeout`
- 请求超时：`gateway request timeout after <N>ms: <method>`
- 请求被取消：`gateway request aborted: <method>`
- 发送失败：`gateway send failed: ...`
- Socket 关闭：`gateway closed (<code>): <reason>`

## 7. 最小使用示例

```ts
import { GatewayClient } from './gatewayClient.js';

const client = new GatewayClient({
  url: 'ws://127.0.0.1:18789/',
  token: process.env.OPENCLAW_API_KEY,
  onEvent: (evt) => {
    if (evt.event === 'chat') {
      // 处理聊天流式事件
    }
  }
});

client.start();
await client.waitForHello();

const res = await client.request<{ runId: string }>('chat.send', {
  sessionKey: 'telegram:dm:123',
  message: 'hello',
  idempotencyKey: 'req-1'
});

console.log(res.runId);
```

## 8. 在本项目中的调用关系

- `src/openclaw/client.ts`
  - 负责基于 `GatewayClient` 封装业务会话
  - 维护每个 Telegram 用户的 gateway session
  - 聚合 `chat/agent/cron` 事件，最终产出 `OpenClawChatReply`
- `src/telegram/bot.ts`
  - 调用 `sendChatToOpenClaw()`
  - 把流式文本回传到 Telegram
