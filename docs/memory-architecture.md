# Memory / Profile / Skill 架构（v3 定稿）

> **状态**：已实施。代码在 `feat/memory-architecture-v3` 分支，分阶段提交。
> **范围**：每个用户对应的 OpenClaw 容器内的数据存储与进化机制 + APIs `user_devices` 中心 registry。
> **维护**：本文档与代码同步演进。改 schema 必须同时改本文档。

---

## 一、设计哲学

数据按"加工程度"分四层，每一层职责正交：

```
Tier 0  raw                字段规范的批量数据池，按 source 分表
                          来源：connector 同步、device snapshot
                          特点：原样存、量大、面向 evolution agent

Tier 1  personal_signals   待消化的瞬时观察 / world_signals 外部资讯
                          来源：device 端侧加工后上传、evolution 摘要、connector 实时事件
                          特点：短期、时序、30 天 TTL、等待提炼为 memory

Tier 2  memory             沉淀的事实层
                          来源：仅 evolution agent + manual
                          特点：长期、quality 加权、跨时间稳定

Tier 3  profile + skill    高度浓缩的画像 + 可执行技能
                          profile：身份 + summary + 高频稳定 fact
                          skill：索引在表，body markdown 在 folder
```

**进化路径**：
- 端侧 SDK 决定：高频低价值 → 不上传；状态变化 → personal_signals；周期 snapshot → raw
- 云端 evolution agent 周期跑：raw + signals → memory；累积证据 → profile.summary 更新；用户行为变化 → skill update
- pipeline 生成卡片：直接读 memory + profile + skill + signals 最近 24h + raw 时间窗口

---

## 二、存储拓扑

`proactive.db` (实际 18 张表，含 v2 遗留 + 子系统私有；agent 主要消费的是粗体那 9 张) +
`mobile_items.db`（端侧上传 sink，每次 ingest 同步镜像到 personal_signals） +
`raw.db`（按 source 分表） + `skills/` folder + LanceDB 向量索引。

```
proactive.db                              mobile_items.db (端侧协议兼容)
├─ profile                                ├─ mobile_items
├─ memory                ★                ├─ mobile_ingest_batches
├─ personal_signals      ★                └─ mobile_item_runs
├─ world_signals         ★
├─ skill_index           ★                raw.db (按 source 分表)
├─ evolution_runs        ★                ├─ gmail_messages           ★
├─ pipeline_runs         ★                ├─ gcal_events              ★
├─ card_evaluations      ★                ├─ device_apps_snapshot     ★
├─ intent_card_state     ★                ├─ device_contacts_snapshot
├─ intent_thread_state                    ├─ notion_pages (v2)
├─ feedback_events                        └─ slack_messages (v2)
├─ goals                 (v2 遗留)
├─ profile_signals       (v2 遗留)        skills/                     LanceDB
├─ profile_interests     (v2 遗留)        └─ <skill_id>/SKILL.md      pf_personal_documents
├─ user_settings                                                       pf_world_signals
├─ auto_loop_state       (v2 遗留)        data/run-artifacts/<id>.json
├─ chat_crystallize_state (v2 遗留)
├─ dream_runs            (dreaming 私有)
├─ push_records          (无 push 功能)
├─ push_outcomes         (无 push 功能)
└─ app_state (KV)        ★
```

**★ = 本次 v3 设计的核心表**。`v2 遗留` 标记的几张是历史 schema，目前还有 helper 在写
（`getAutoLoopState` / `getCrystallizeState` 等），**未来 PR 可挪到 `app_state` KV**。
`push_records` / `push_outcomes` 没有产品功能，可直接删，留作下次清理。
`dream_runs` 是 dreaming 子系统私有 store；每次 dream 同时写一条 summary 到 `evolution_runs`。

---

## 三、核心表 Schema（节选关键字段）

### memory（沉淀的事实层）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | ULID |
| text | TEXT | 事实本身（一句话或一段） |
| source | TEXT | `crystallize` / `dream` / `manual` / `device:trigger` / `extract:gmail` |
| source_run_id | TEXT | → `evolution_runs.id`，可空（manual 写时为空） |
| subject | TEXT | `self` / `person:zhang@x.com` / `place:home` / `topic:investing` / `goal:health` |
| quality | REAL | 0..1 综合质量（evolution agent 给；device:trigger 强制 ≤ 0.7） |
| confidence | REAL | 0..1 信心 |
| status | TEXT | `active` / `archived` / `superseded` |
| superseded_by | TEXT | 被哪条新 memory 替换 |
| occurred_at | TEXT | 事实发生时间（可空） |
| created_at | TEXT | 写入时间 |
| tags_json | TEXT | JSON array |
| reference_count | INT | 被 retrieval 引用次数 |
| last_referenced_at | TEXT | 上次被引用 |
| referenced_by_runs | TEXT | 最近 10 个 run id（capped JSON array） |

**写入规则**：
- 不前置 LLM 判重，靠时间维度——后写的覆盖旧的
- 显式 `supersede(old_id, new_id)` 才创建链
- consolidation pass 在后台周期跑（trigger='consolidation'）

### personal_signals（待消化的瞬时观察）

兼容端侧 `MobileSyncItem` schema，是端侧 production 上传的 sink。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| kind | TEXT | (原 `itemType`) `attention_item` / `session_summary` / `moment` |
| title | TEXT | |
| summary | TEXT | |
| payload_json | TEXT | 端侧原 payload |
| salience | REAL | 端侧或 LLM 给的"值得关注度" |
| confidence | REAL | |
| dedupe_key | TEXT UNIQUE | 端侧 `CanonicalPayloadHasher` 算 |
| occurred_at | TEXT | |
| available_at | TEXT | |
| expires_at | TEXT | 默认 +30 天 |
| source | TEXT | `device` / `evolution:digest` / `connector:gmail_burst` |
| device_id | TEXT | |
| subject | TEXT | 同 memory.subject |
| source_raw_table | TEXT | 关联回 raw 表（如果是 raw 派生的） |
| source_raw_ids_json | TEXT | |
| status | TEXT | `open` → `consumed` → `archived` |
| consumed_by_run_id | TEXT | 被哪次 evolution_run 提炼 |
| reference_count, last_referenced_at, referenced_by_runs | | 同 memory |

**生命周期**：
- 端侧/云端写入 → `status='open'`
- pipeline 拉 `open AND occurred_at > now-24h` 进 prompt
- evolution agent 提炼成 memory 后 → `status='consumed'`
- 30 天后 → `status='archived'`（不删，可调试）

### evolution_runs（统一进化记录）

dream / crystallize / manual / consolidation 都写这张表。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| trigger_kind | TEXT | `chat_burst` / `daily_dream` / `manual` / `on_event` / `consolidation` |
| status | TEXT | `running` / `completed` / `failed` |
| context_summary | TEXT | LLM 自述这次拉了什么 |
| memories_written, memories_archived, profile_updated, skills_added, skills_updated | INT | 数字统计 |
| refs_consumed_json | TEXT | `{"personal_signals":["..."], "gmail_messages":["..."], "memory":["..."]}` |
| refs_produced_json | TEXT | `{"memory":["..."], "skill_index":["..."]}` |
| started_at, completed_at, duration_ms, llm_tokens, error_message | | |

**反向追溯**：
- 看一次 run 改了什么：`refs_produced_json`
- 看一条 memory 怎么来的：`SELECT * FROM evolution_runs WHERE id = memory.source_run_id`

### skill_index（索引；body 在 folder）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | 同时是 `skills/<id>/` 文件夹名 |
| title, description | TEXT | |
| status | TEXT | `enabled` / `disabled` / `archived` |
| revision | INT | 每次 SKILL.md 改动 +1 |
| body_hash | TEXT | SHA256(SKILL.md)，检测变化 |
| triggers_json | TEXT | `["when X", "if Y"]` |
| source, created_run_id, last_updated_run_id | | 来源追溯 |

**update 触发逻辑（v1）**：evolution agent 永远只 add 新 skill，update 留给 manual。**v2 视使用情况引入 hermes 风格的 self-improve**（基于持续反馈触发 update）。

### profile（极简画像）

```
id (default 'self'), display_name, locale, timezone,
summary,                      -- LLM 写的人物 summary，evolution 周期 rewrite
attributes_json,              -- 高频稳定 fact (job, birthday, family)
updated_at
```

facts/preferences/constraints 不再存 profile；都改写成 memory（quality > 0.7 的高质量 memory）。

---

## 四、数据流（两个真实场景）

### 场景 A：device 端侧 trigger（GPS home → office）

```
端侧
├─ GPS 每秒原始 fix ──> 端侧本地消费，不上传
└─ EventFilterEngine + ItemDerivationEngine 判定为重要变化
   ↓ POST /api/proxy/mobile/items/ingest
   ↓
personal_signals 一行:
   kind = 'moment'
   text = "周三 8:00 从家到公司，用时 25 分钟（比平时晚 10 分钟）"
   source = 'device'
   salience = 0.65
   dedupe_key = 'device:loc:home_to_office:2026-04-23'
   status = 'open'

─── 当天 ─────────────────────
pipeline_run 启动
   ↓ pin signals recent --hours 24
   ↓ 这条信号被拉到，进 prompt
   ↓ LLM 生成卡片
   ↓ markReferenced('personal_signals', [id], run_id)

─── 几天后 ───────────────────
evolution_run (daily_dream) 跑
   ↓ 看到 5 天 location_change 都是 home→office 8:00
   ↓ 提炼成 memory:
     text = "用户工作日 8 点通勤"
     source = 'extract:device_signals'
     quality = 0.75
   ↓ 5 条 signals → status='consumed'
```

### 场景 B：device 全量 snapshot（40 个 APP）

```
端侧扫描
   ↓ POST /api/proxy/mobile/items/ingest (itemType='app_inventory_bootstrap')
   ↓
云端 handler 双写:
   ├─ personal_signals 一行 (kind='attention_item', payload 含完整列表)
   └─ raw.db.device_apps_snapshot (40 行)

─── 当天 pipeline 不读 raw（snapshot 不直接进 prompt）

─── 下次 evolution_run ─────
   ↓ pin device apps --top 20
   ↓ LLM 提炼 3 条 memory:
     "用户关注个人投资（Robinhood + 雪球）" quality 0.6
     "持续跑步习惯（Strava + Nike Run）" quality 0.6
   ↓ markReferenced('device_apps_snapshot', [40 个 row id], run_id)
```

**两类数据的核心区别**：
- 端侧加工过的（`session_summary` / `moment` / `attention_item`）→ 进 personal_signals
- 端侧批量同步的（snapshot 类）→ 同时进 raw（按 source 分表的具体行）

---

## 五、关键规则（强约束）

| 规则 | 说明 |
|---|---|
| **reference 三件套** | 所有需要追溯的表（raw 各表 + memory + personal_signals + world_signals + skill_index + feedback_events）都加 `reference_count` / `last_referenced_at` / `referenced_by_runs`。统一通过 `markReferenced(table, ids, run_id)` 写入 |
| **referenced_by_runs cap** | 只保留最近 10 个 run id，超出 truncate；避免无限增长 |
| **memory.quality 边界** | `device:trigger` 强制 quality ≤ 0.7；高 quality 仅由 evolution agent 提升 |
| **personal_signals.status 流转** | `open` → `consumed`（被 evolution 用过）→ `archived`（30 天 TTL） |
| **memory.source enum** | 字符串 enum：`crystallize` / `dream` / `manual` / `device:trigger` / `extract:<source>`；不建 source 表 |
| **memory 写入** | 不前置 LLM 判重，靠时间覆盖；显式 `supersede(old_id, new_id)` 才有 superseded 链 |
| **skill update（v1）** | evolution agent 永远只 add，update 留给 manual；revision 字段为 v2 self-improve 预留 |
| **大 JSON 不进 SQLite** | pipeline_runs.iterations / evolution_runs.detail 这种 18KB+ JSON 改写 `data/run-artifacts/<id>.json` |

---

## 六、CLI 接口（agent 一等公民）

LLM 通过 `pin` CLI 拉 context。所有命令本地查 SQLite + folder，**毫秒级**。

```bash
# 画像（最常用）
pin profile get                              # singleton profile + goals
pin memory list --quality 0.7 --limit 30
pin memory list --subjectPrefix person: --limit 20
pin memory search --query "投资偏好" --limit 10   # --top 也可；SQL LIKE，非 top-N 预筛
pin skills list --status enabled
pin skills show --id <skill_id>              # cat skills/<id>/SKILL.md

# 即时上下文 (raw 数据 namespaced under `pin raw`)
pin signals recent --hours 24                # personal_signals.status='open'
pin raw gmail recent --hours 24 --limit 20
pin raw gcal today --timezone Asia/Shanghai  # 不传 --timezone 用 profile.timezone，再退化到 UTC
pin raw gcal week
pin raw device-apps --deviceId <id> --top 20
pin raw device-contacts search --query "张" --deviceId <id>   # SQL 内过滤，LIMIT 生效于匹配集

# 反思（让 agent 知道自己历史）
pin evolution recent --kind daily_dream --limit 5
pin evolution recent --limit 5               # all kinds
pin cards recent --limit 10
pin feedback list --since 7d

# 写入（manual / evolution agent）
pin memory add "<text>" --quality 0.6 --subject self
pin memory add --text "<text>" --source manual --quality 0.7
pin skills add --id <id> --title "..." --source manual --from-file SKILL.md
pin profile update --summary "..." --display-name "..."
```

> 同事调试时若敲了未实现的命令（例如老文档里的 `pin profile summary` / `pin gmail recent` / `pin runs recent` / `pin device apps`），CLI 会返回 `ok=false` + 错误码。直接以本节为准。

unified-generator 的 phase 1 由"跑 12 个 CLI" 改为"先看 ContextPack 预查 + 按需调用上述 CLI 拓展"。

---

## 七、老表 → 新位置（迁移现状）

每行的 **状态** 列反映 `feat/memory-architecture-v3` 已实施部分，最右列标出 follow-up PR 待办。

| 老表 | 去哪 | 状态 | 还需 |
|---|---|---|---|
| profile | profile（保留） | 部分实施：字段不变，新事实推荐写 memory | — |
| profile_memories | memory | ✅ 自动 backfill + DROP（`migrateLegacyToV3`） | — |
| profile_signals | 保留作 v2 遗留 | helpers 仍写老表 | follow-up：迁到 memory 或删 |
| profile_interests | 保留作 v2 遗留 | 同上 | 同上 |
| goals | 保留作 v2 遗留 | 同上 | 同上 |
| user_skills | skill_index + folder | ✅ 自动 backfill + DROP | — |
| world_items | world_signals（改名） | ✅ 自动 ALTER RENAME + 加 reference 三字段 | — |
| feedback_events | 保留 | ⚠️ 暂未加 reference 三字段 | follow-up：加字段或显式不加 |
| push_records / push_outcomes | 没真用 | ⚠️ 表 + helper 仍存在但 0 行 | follow-up：DROP + 删 helper |
| pipeline_runs | 精简 | ✅ iterations 写 artifact 文件；评分拆 `card_evaluations` | — |
| intent_card_state / intent_thread_state | 保留 | 聊天部分别动 | — |
| user_settings | 保留 | | — |
| auto_loop_state | 计划 → app_state(scheduler.*) | ⚠️ KV 表已加，但 scheduler 仍写老表 | follow-up：scheduler 切到 KV |
| chat_crystallize_state | 计划 → app_state(crystallize.*) | ⚠️ 同上 | follow-up |
| ingest_cursor | DROP | ✅ 删（0 行） | — |
| dream_runs | dreaming 子系统私有 + mirror 到 evolution_runs | ✅ Phase 8 hook | follow-up：dreaming 重写后 DROP |
| pending_items / context_runs | DROP | ✅ 删（0 行） | — |
| mobile_items | 镜像到 personal_signals（不 DROP） | ✅ 每次 ingest 同步写 + bridge snapshot 到 raw.db | 端侧协议保留 |
| mobile_ingest_batches | 保留 | 仍由 mobile-db.ts 写（监控批次） | follow-up：移到 metrics |
| mobile_item_runs | 保留 | claim/commit 模式仍服务老 CLI | follow-up：CLI 切到 personal_signals 后 DROP |

**实际净变化**：v3 新增 8 张表（memory / personal_signals / skill_index / evolution_runs / card_evaluations / app_state / world_signals 改名 / 4 张 raw 表）；自动迁移 + DROP 3 张（profile_memories / user_skills / 3 张零行表）；其它 v2 表分两类——dreaming/crystallize/mobile 子系统私有保留，profile_signals/interests/goals 等 v2 遗留留作 follow-up。

---

## 八、阶段实施

实施分 14 个 commit（Phase 0-13），全部完成在 `feat/memory-architecture-v3` 分支。

| Phase | 内容 | 状态 |
|---|---|---|
| 0 | 写本文档 | ✅ |
| 1 | `app_state` KV + `card_evaluations` 表 + `pipeline_runs.artifact_path` + 删 3 张零行表（`pending_items` / `context_runs` / `ingest_cursor`） | ✅ |
| 2 | `memory` + `skill_index` + `skills/<id>/SKILL.md` folder + helpers | ✅ |
| 3 | `evolution_runs` ledger + trajectory（`refs_consumed_json` / `refs_produced_json`） | ✅ |
| 4 | `personal_signals` + `raw.db`（`gmail_messages` / `gcal_events` / `device_apps_snapshot` / `device_contacts_snapshot`） | ✅ |
| 5a | dual-write bridges（legacy → v3，被 Phase 13 替代） | ✅ |
| 5b | HTTP routes（`/memory` / `/signals` / `/raw/*` / `/evolution`） | ✅ |
| 5c | end-to-end smoke test | ✅ |
| 6 | `world_items` → `world_signals` 改名 + 自动 ALTER RENAME 迁移 | ✅ |
| 7 | `pin` CLI v3 命令（`pin memory` / `pin signals` / `pin raw` / `pin evolution` / `pin skills`） | ✅ |
| 8 | conversation-crystallize + dreaming 写 `evolution_runs`（trajectory 可见） | ✅ |
| 9 | `unified-generator` phase 1 prompt 改造为 v3 CLI 链路 | ✅ |
| 10 | evals harness 框架（types / metrics / online） | ✅ |
| 11 | APIs `user_devices` 表 + `mobile_proxy` token 路由 + 前端 `ensureDevice` SDK | ✅ |
| 12 | agent-visible CLI smoke demo + `raw.device-apps` envelope fix | ✅ |
| 13 | 一次性 backfill + DROP 老表（`profile_memories` / `user_skills`），helpers redirect 到 v3 | ✅ |

**变更净结果**：23 张 → 13 张 + `raw.db` 一组 + `skills/` folder。
**测试**：plugin 260+ / 260+ ✅（数字随 PR 演进）；APIs + frontend type-check + 单测全过；CLI smoke 16 命令全过。

后续工作（独立 PR）：
- consolidation trigger（evolution agent 周期净化 memory）
- evals/runner/replay.ts + golden fixtures（实际 eval 跑起来）
- 端侧 SDK 在 OAuth 后调一次 `ensureDevice()` 拿 token
- 把 `dream_runs` 内部 store 也合并到 `evolution_runs`（dreaming 子系统重写）

---

## 九、FAQ

**Q：raw 跟 memory 都存，会不会重复？**
A：不重复。raw 是 source of truth（"用户当前装了哪些 app"），memory 是 agent 提炼的洞察（"用户关注个人投资"）。两者服务不同检索场景：raw 答事实问题，memory 答画像问题。

**Q：端侧上来的 GPS 事件为什么不直接进 memory？**
A：单条 GPS 是事件 / 信号，不是事实。"周三 8:00 home→office" 不算 memory；"用户工作日 8 点通勤"（5 天聚合后）才算 memory。前者进 personal_signals，后者由 evolution agent 提炼后进 memory。

**Q：memory 会无限膨胀吗？**
A：consolidation pass（v2 实现）周期跑——LLM review 旧 memory，archive 失效的、supersede 重复的。短期内靠 reference_count 排序：长期没被引用的低 quality memory 优先被 archive。

**Q：connector 数据全量保留还是滚动 30 天？**
A：raw 各表全量保留（用户决策）。膨胀监控：每周扫 `SELECT source, COUNT(*), SUM(LENGTH(payload_json)) FROM ...` 入指标。预期单用户 200 MB-2 GB / 年，可接受。超过 1 年的 raw 可考虑 cold archive 到对象存储。

**Q：端侧协议要改吗？**
A：v1 不改。云端 handler 兼容现有 `/api/mobile/items/ingest`，自动把上传的 item 写入 personal_signals + bridge snapshot 类 payload 到 raw 各表。端侧 SDK 文档可独立演进。

**Q：world 和 personal 都叫 signals，要合并表吗？**
A：不合并。schema 差异大（world 有 url/provider/topics/regions，personal 有 device_id/source_raw_table）。但概念对齐、CLI 形态对齐：`pin signals recent` 和 `pin world recent` 心智一致。

---

## 十、维护

- 改 schema 必须同步改本文档
- 加新 raw 表必须列在"存储拓扑"里
- 改 evolution agent 行为必须更新"数据流"段
- 命名变更（personal_signals / memory / skill_index 等）需 ADR 决议
