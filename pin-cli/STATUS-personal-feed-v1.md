# Personal Feed V1 状态

最后更新：`2026-04-02`
当前分支：`feat/personal-feed-v1`

## 目标
把用户个人数据通过 `Composio` 同步到本地 `SQLite`，并通过 `pin personal ...` 提供给 Agent 使用。

当前 V1 范围：
- 个人流，不含世界流
- 本地 SQLite 落库
- 关键词检索 + 语义检索 + 混合检索
- 先做同步和搜索，不做复杂推送逻辑

## 当前结论
当前 feature 已经从“方案阶段”进入“可运行阶段”。

已经真实跑通的链路：
- `Gmail -> sync -> SQLite -> embedding -> semantic search -> hybrid search`

已经本地实现并有测试覆盖的 source：
- `gmail`
- `googlecalendar`
- `notion`

## 当前实现

### CLI
已支持：
- `pin personal source list --json`
- `pin personal sync run --all --json`
- `pin personal sync status --json`
- `pin personal timeline --from ... --to ... --json`
- `pin personal item get --id ... --json`
- `pin personal search --query ... --strategy keyword|semantic|hybrid --json`
- `pin personal index refresh --all|--pending --json`

### 数据表
个人流表：
- `pf_connected_sources`
- `pf_context_items`
- `pf_sync_runs`
- `pf_sync_state`
- `pf_context_items_fts`

语义索引：
- `PIN_DATA_ROOT/index/personal.lancedb`

### 已支持的 source
- `gmail`
  - 邮件同步
- `googlecalendar`
  - 日历事件同步
- `notion`
  - page / database 基础同步

## 已验证

### 自动化验证
当前通过：
- `npm run test --workspace @pin-ai/pin-cli`
- `npm run type-check --workspace @pin-ai/pin-cli`
- `npm run build --workspace @pin-ai/pin-cli`

当前测试数：
- `35` 个测试通过

### 真实 E2E
可运行脚本：

```bash
cd pin-cli
export COMPOSIO_API_KEY='...'
export OPENAI_API_KEY='...'
export PIN_DATA_ROOT=/tmp/pin-personal-e2e-real
npm run test:e2e:personal
```

最近一次真实结果：

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

## 最近完成
- 加入个人流基础同步链路
- 所有 `pf_*` 主表补上 `user_id`
- 加入 `LanceDB + OpenAI embedding`
- 加入 `semantic / hybrid` 搜索
- 加入 `pin personal index refresh`
- 加入 `googlecalendar` sync spec
- 加入 `notion` sync spec
- 加入真实 E2E 脚本
- 修复 FTS 查询遇到 `Re:` 等特殊字符会报错的问题

## 当前待做

### 高优先级
- `slack` sync spec
- `profile` 自动提炼回写
- 轮询调度器

### 中优先级
- 更细的 source 增量同步策略
- 更稳定的 embedding/index refresh 策略
- 把真实 E2E 扩到 `calendar / notion`

## 当前风险
- 当前真实跑通的是 `gmail`，`calendar / notion` 目前是代码级和测试级通过，未做真实账号验证
- `semantic search` 是近似召回，所以 E2E 对 semantic 只要求“非空”，不要求一定命中样本 item
- `OPENAI_API_KEY` 不会写入仓库，真实语义链路测试需要显式 export

## 给 AI 的续开发指令
新 session 开始时，先做这三步：

1. 切分支：
```bash
git checkout feat/personal-feed-v1
```

2. 先读这个文件：
- [STATUS-personal-feed-v1.md](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/STATUS-personal-feed-v1.md)

3. 跑最小验证：
```bash
npm run test --workspace @pin-ai/pin-cli
```

如果要继续开发，默认下一项是：
- `slack sync spec`

## 关键文件
- [service.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/src/domains/personal/service.ts)
- [repository.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/src/domains/personal/repository.ts)
- [sync_specs.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/src/domains/personal/sync_specs.ts)
- [embedding.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/src/domains/personal/embedding.ts)
- [semantic_index.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/src/domains/personal/semantic_index.ts)
- [e2e.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/src/domains/personal/e2e.ts)
- [personal-feed-e2e.ts](/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT/pin-cli/scripts/personal-feed-e2e.ts)

## 维护规则
后续每次在这个 feature 上开发，都更新这一个文件，至少改这几项：
- `最后更新`
- `最近完成`
- `当前待做`
- `已验证`
- `当前风险`
