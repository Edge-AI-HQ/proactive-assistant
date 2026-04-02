# Personal Feed V1 交接说明

## 当前分支
- 分支：`feat/personal-feed-v1`
- 当前最新提交：
  - `d3bf4e91` `feat(pin-cli): add personal feed e2e coverage`
  - `97ff017a` `feat(pin-cli): add notion personal sync spec`
  - `03a9c5e3` `feat(pin-cli): add personal semantic search and calendar sync`
  - `addcd983` `feat(pin-cli): add personal feed sync v1`

## 当前目标
在 `pin-cli` 内落地个人信息流第一版，让用户已授权的个人数据可以：
- 从 Composio 拉取
- 同步到本地 SQLite
- 被 Agent 通过 `pin personal ...` CLI 读取
- 支持关键词检索、时间线检索、语义检索、混合检索

当前这版只做个人流，不做世界流。

## 已完成能力

### 1. 数据层
当前个人流表都在同一个 SQLite：`PIN_DATA_ROOT/data/pin.db`

已落表：
- `pf_connected_sources`
- `pf_context_items`
- `pf_sync_runs`
- `pf_sync_state`
- `pf_context_items_fts`

语义索引目录：
- `PIN_DATA_ROOT/index/personal.lancedb`

补充字段：
- 所有 `pf_*` 主表都已带 `user_id`
- `pf_context_items` 已带语义索引状态字段：
  - `semantic_indexed_at`
  - `semantic_model`
  - `semantic_content_hash`

### 2. CLI 能力
已支持：
- `pin personal source list --json`
- `pin personal sync run --all --json`
- `pin personal sync status --json`
- `pin personal timeline --from ... --to ... --json`
- `pin personal item get --id ... --json`
- `pin personal search --query ... --strategy keyword|semantic|hybrid --json`
- `pin personal index refresh --all|--pending --json`

### 3. 已接通的 sync spec
当前已支持：
- `gmail`
- `googlecalendar`
- `notion`

其中：
- Gmail：同步邮件
- Google Calendar：同步日历事件
- Notion：同步 page / database 基础信息

还没做：
- `slack`
- `profile 自动提炼回写`
- `轮询调度器`

### 4. 搜索能力
已支持：
- SQLite 结构化过滤
- SQLite FTS5 关键词搜索
- LanceDB 向量索引
- `semantic`
- `hybrid`

降级规则已处理：
- `semantic` 不可用时返回 `UNAVAILABLE`
- `hybrid` 不可用时自动降级为 `keyword`

已修复一个真实 bug：
- FTS 搜索原始标题如 `Re: xxx` 会触发 SQLite FTS 解析错误
- 现在 repository 层会先把 query 做安全归一化

## 真实验证结果

### Gmail 真实链路已跑通
使用真实 Composio 授权账号和真实 OpenAI key 跑过：
- `Gmail -> sync -> SQLite -> index refresh -> semantic -> hybrid`

最近一次真实 e2e 输出：

```json
{
  "ok": true,
  "summary": {
    "toolkit": "gmail",
    "query": "Re: Thinking about ways to maximize ARPU lately?",
    "sourceCount": 1,
    "syncedSourceCount": 1,
    "fetchedCount": 10,
    "timelineCount": 10,
    "indexedCount": 10,
    "semanticResultCount": 5,
    "hybridResultCount": 5,
    "sampleItemId": "src_gmail_ca_U6XYWxXMtVJL:email:19d4eba90ae6a05a"
  }
}
```

说明：
- Gmail source 数量：`1`
- 成功同步邮件：`10`
- 成功建立 embedding：`10`
- semantic search：正常返回
- hybrid search：正常返回

## 测试与验证命令

### 常规回归
在仓库根目录执行：

```bash
npm run test --workspace @pin-ai/pin-cli
npm run type-check --workspace @pin-ai/pin-cli
npm run build --workspace @pin-ai/pin-cli
```

当前状态：
- `35` 个测试通过

### 真实 e2e
在仓库根目录执行：

```bash
cd pin-cli
export COMPOSIO_API_KEY='你的 Composio key'
export OPENAI_API_KEY='你的 OpenAI key'
export PIN_DATA_ROOT=/tmp/pin-personal-e2e-real
npm run test:e2e:personal
```

默认测：
- `gmail`

可选参数：

```bash
export PIN_PERSONAL_E2E_TOOLKIT=gmail
export PIN_PERSONAL_E2E_LOOKBACK_DAYS=180
export PIN_PERSONAL_E2E_TIMELINE_LIMIT=10
export PIN_PERSONAL_E2E_SEARCH_LIMIT=5
export PIN_PERSONAL_E2E_INDEX_LIMIT=200
```

## 关键代码位置

### Personal 主逻辑
- [service.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/src/domains/personal/service.ts)
- [repository.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/src/domains/personal/repository.ts)
- [sync_specs.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/src/domains/personal/sync_specs.ts)
- [provider.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/src/domains/personal/provider.ts)
- [executor.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/src/domains/personal/executor.ts)
- [register.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/src/domains/personal/register.ts)

### 语义检索
- [embedding.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/src/domains/personal/embedding.ts)
- [semantic_index.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/src/domains/personal/semantic_index.ts)

### E2E
- [e2e.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/src/domains/personal/e2e.ts)
- [e2e.test.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/src/domains/personal/e2e.test.ts)
- [personal-feed-e2e.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/scripts/personal-feed-e2e.ts)

## 新 Session 如何继续
新开一个 session 时，先明确这几点：

1. 当前分支：
```bash
git checkout feat/personal-feed-v1
```

2. 先读这份文档：
- [HANDOFF-personal-feed-v1.md](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/HANDOFF-personal-feed-v1.md)

3. 再跑一次最小验证：
```bash
npm run test --workspace @pin-ai/pin-cli
```

4. 如果要跑真实链路：
```bash
cd pin-cli
export COMPOSIO_API_KEY='...'
export OPENAI_API_KEY='...'
export PIN_DATA_ROOT=/tmp/pin-personal-e2e-real
npm run test:e2e:personal
```

## 下一步建议顺序
建议继续按这个顺序做：

1. `Slack` 的 personal sync spec
- 价值高
- 也是强个人流 source
- 做完之后，个人消息流就比现在完整很多

2. `profile 自动提炼回写`
- 从 `pf_context_items` 提炼 profile facts / preferences / goals

3. `轮询调度器`
- 把当前手工 `pin personal sync run --all` 变成定时任务

## 风险与注意事项

### 1. OpenAI key 不要写入仓库
- 本轮真实测试用过真实 key
- 但没有写入代码、脚本或仓库文件
- 新 session 若要跑真实 semantic，必须重新显式 export

### 2. semantic e2e 的断言策略
- `semantic` 是近似召回，不保证一定把“样本 item”排回来
- 当前 e2e 断言是：
  - `semantic` 只要求非空
  - `hybrid` 要求能把样本 item 命中回来

### 3. 当前仍是单用户假设下开发
- 表里已经有 `user_id`
- 但更完整的多用户隔离和调度层还没做完

## 一句话状态
当前 `personal feed v1` 已经从“设计”进入“可真实运行的第一版”：
- Gmail 已真实跑通
- Calendar / Notion 已完成本地实现和测试
- semantic / hybrid 已完成
- e2e 脚本已可重复执行
