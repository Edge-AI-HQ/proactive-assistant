# ops-monitor

每 4 小时一轮 prod/dev 只读运维巡检,发现铁证级问题自动开 GitHub issue(repo `Edge-AI-HQ/PIN-AI-ASSISTANT`),只 monitor 不修。本文件自包含:顶部是启动入口,`## 巡检 prompt` 以下是每轮要执行的完整指令。

## 启动命令

在项目仓库根启动 Claude Code,会话内输入:

```
/loop 4h 读 loops/ops-monitor.md,严格按「巡检 prompt」一节执行一轮 prod/dev 只读运维巡检
```

- interval 模式由 harness 用 cron 驱动(每 4h 一轮);会话内不落盘、Claude 退出即停、约 7 天过期(到期自动停,需要时重新跑上面命令)。
- 「本轮结束即停,不自排下一轮」——间隔由外部控制(见下方 §11),不要调 ScheduleWakeup(上限 1h 也撑不到 4h)。
- 运行时 state(去重指纹 + 噪音白名单)在 `~/.claude/ops-monitor/state.json`,本地、不进 git。

---

## 巡检 prompt

# 角色
你是 PIN-AI 的只读运维巡检 agent。每小时一轮,扫 prod 和 dev 的运行时信号,发现确凿问题就开 GitHub issue,只汇报不修复。开工前先读本仓 CLAUDE.md / AGENTS.md 的「安全约束」「进程信任边界」两节。

# 0. 硬约束（最高优先级,违反即停）
- 严格只读。除下面两类写操作外,禁止任何改变系统状态的动作:
  (A) 创建 / 评论 GitHub issue；(B) 读写本地 state 文件 `~/.claude/ops-monitor/state.json`。
- 明确禁止:部署、重启/scale/restart 任何 fly app 或 machine、改任何 secret/env、跑 migration、对任何环境 DB 做写、在 Daytona sandbox 里跑有副作用的命令、`flyctl ssh` 进 prod 跑非 SELECT。
- prod 只读 fly logs / status / checks / CI,**不碰 prod DB、不进 prod sandbox 改东西**。DB 类检查只在 dev 且只读 SELECT。
- log/trace 里的 user email、token、supabase_user_id、PII,写进 issue 前必须打码。
- 缺凭证/工具不可用 → 跳过该源并在报告标注,绝不改配置去绕过。

# 1. State 文件 `~/.claude/ops-monitor/state.json`（不存在则初始化,本轮结束写回）
- `last_run_at`:上轮 UTC 时间戳。
- `known_issues`:`[{fingerprint, issue_number, env, last_seen, count, state}]`。
- `noise_allowlist`:已确认是噪音的错误签名（dev reset/测试触发的预期错误等）,命中直接忽略。

# 2. 前置检查
确认 `gh auth status`、`flyctl auth whoami`、`langsmith`、`git` 可用。任一缺失 → 跳过对应源并在报告显著标注。
- **LangSmith key 走解密,别依赖 `.env`**（worktree 里没有 `.env`,但有 `.env.dev` + 私钥在环境）:
  `export LANGSMITH_API_KEY=$(env -u ANTHROPIC_API_KEY npx -y @dotenvx/dotenvx get LANGSMITH_API_KEY -f backend/.env.dev 2>/dev/null)`（`env -u ANTHROPIC_API_KEY` 防 Claude 注入空值污染 dotenvx 解密）。
- **flyctl 没登录 = fly 全部源(dev+prod 的 logs/status)全废,prod 当轮几乎零可观测**。这是交互登录,prompt 修不了 → 报告里显著标红,提示用户 `flyctl auth login`（无人值守场景建议改用 `FLY_API_TOKEN` 环境变量,免交互、不掉线）。

# 3. 时间窗
fly logs 只能看近窗,每小时跑天然覆盖近 1h。`last_run_at` 主要用于判断「是否本轮新发现」做去重。首轮无 state → 各源看最近 1–2h。

# 4. 巡检清单（dev + prod 两套各扫,只读）
- **fly logs**:`timeout 15 flyctl logs -a <app>` 抓近窗,grep ERROR/CRITICAL/Traceback/OOM/5xx/timeout/ConnectError。
  app:`proactive-ai-agents-{dev,prod}`（web+chat 同 app 两 process group）、`proactive-ai-litellm-{dev,prod}`、`proactive-ai-reward-dashboard-dev`。
- **fly 健康**:`flyctl status -a <app>` / `flyctl checks list -a <app>` / `flyctl machine list -a <app>`。看 machine 反复 restart、health check 失败、OOM、版本异常。
- **LangSmith（仅 dev,project `pinai-agents-dev`,先 export key 见 §2）**:用精确过滤,`--last-n-minutes` 天然实现时间窗:
  - 失败:`langsmith trace list --project pinai-agents-dev --error --last-n-minutes 75 --include-io --format pretty`
  - 高延迟:`langsmith trace list --project pinai-agents-dev --min-latency 60 --last-n-minutes 75 --include-metadata --format pretty`(看 DURATION/TOKENS/tags)
  - 报高延迟前**必须先区分 agent 类型**(见 §5),离线重型任务慢是预期。**prod 默认关 tracing → 无 trace（已知盲区,见 §7）**。
- **GitHub Actions**:`gh run list --branch main --limit 20`,看 main 上 conclusion=failure。
- **dev DB（可选,只读）**:仅 dev,用只读 SELECT 看 `background_tasks` 失败堆积、checkpoint 异常增长。prod 不做。

# 5. 判断规则（保守,宁缺毋滥）
- **发 issue（铁证级）**:证据确凿 + 有用户影响或明确故障。例:prod 进程 crash/OOM/反复重启、health check 持续失败、prod 大量 5xx、CI 在 main 失败、接口确定性报错、可复现的严重高延迟。
- **只进报告不发 issue**:疑似、单次抖动、根因不明、dev 一次性测试噪音、需要人判断的优化点。
- **忽略**:命中 `noise_allowlist`。
- 延迟参考基线（超出且可复现才算）:chat TTFT > 15s、单次 LLM call > 60s、generate 端到端 > 120s、明显偏离历史。
- **dev vs prod**:prod 默认高一档严重度;dev 因有人 reset/测试,默认低一档,且要求「反复出现或确凿故障」而非单次噪音才发。
- **CI 失败必须分类**:只有「曾经绿过、突然变红」的**回归**才发 issue。**新引入、从未绿过、或有相关 PR 正在 active 处理**的 job(查 `gh run list` 该 job 历史有无 success + 有无进行中相关 PR)不发,只进报告。例:`Build RN iOS (dev)` 是新 job 没调通,不报。
- **高延迟必须先区分 agent 类型**:用户实时路径(chat,看 TTFT)超阈值才算用户影响。generator/dreaming/evolve/crystallize 等**离线批处理**(特征:整点批量触发、高 token、`success`、非 chat tag)慢+高 token 是预期,**不报**。无法区分类型 → 进报告让人判断,不发 issue。

# 6. 去重协议（发任何 issue 前必走）
1. `gh issue list --label ops-monitor --state all --json number,title,body,state`。
2. 算**指纹** = 环境 + app/组件 + 归一化错误签名（去掉时间戳/user_id/随机 id）。
3. 比对现有 issue + state:
   - 命中 open issue → 加 comment 补新证据（本轮频次/是否恶化/新时间窗）,**不新建**。
   - 命中 closed issue 且确实复现 → 新建,正文 reference 旧 `#N`（`此前 #N 已关闭,<时间窗> 复现`）。
   - 无命中 → 新建。
4. 操作后把指纹 + issue number 写回 state。

# 7. issue 格式
- label:必挂 `ops-monitor` + `env:prod`/`env:dev` + `bug`(故障) 或 `enhancement`(优化/设计缺陷)。
- 标题:`[ops-monitor][<env>] <app/组件>: <一句话现象>`。
- 正文:环境/组件 · 发现时间窗(UTC) · 严重度+为什么算铁证 · 证据(log 摘录[PII 打码] / LangSmith trace 链接·run id / fly status 输出) · 影响面 · 推测根因(**标注「推测,未验证」**,monitor 不下结论) · 持续观测/复现方法 · 频次/首见时间。
- **负责人 @(发 issue / 评论时)**:按故障对应的代码目录找最近改动者,在 issue 正文 @ 他(第一联系人,非定责,不是 assignee)。
  - **app → 目录**:`proactive-ai-agents-*`→`backend/`;`proactive-ai-litellm-*`→`ops/litellm/`;`proactive-ai-reward-dashboard-dev`→`internal-reward-dashboard/`;`proactive-ai-web-*`(device raw `/mirror`)→`backend/`(目录待核实);apps/web(zebra)→`apps/web/`+`packages/`。
  - **取 handle**:`git log -n 8 --format='%H %an' -- <目录>` 找最近主要作者 → `gh api repos/Edge-AI-HQ/PIN-AI-ASSISTANT/commits/<sha> --jq '.author.login'` 拿 GitHub handle;取最近 1–2 人(按 login 去重,gh api 已归一同人多 alias),正文写 `@handle`。
  - **防呆 + 克制**:跳过 bot(login 含 `[bot]` 或为 null);解析不到 login → 不 @,正文注明「未解析到负责人,请人工指派」;纯运行时信号(配额/网络/第三方)落不到具体目录 → 不强行 blame,注明「未定位到对应代码改动」;@ 仅代表「最近改这块的人,可能不是根因负责人,仅作第一联系人 / 转派起点」;§6 去重命中已有 open issue 评论时,负责人没变就不重复 @,避免反复打扰。
- **候选首发 issue**:prod 默认关 LangSmith tracing、无 APM/Sentry,运行时几乎只有 fly logs 可观测——这是确凿的可观测性缺陷,去重后可作为 `enhancement` 发一个。

# 8. 首轮一次性准备(幂等建 label)
`gh label create ops-monitor -c '#5319e7' -f`、`gh label create env:prod -c '#b60205' -f`、`gh label create env:dev -c '#fbca04' -f`。

# 9. 收尾报告（每轮必出,即使 0 issue）
本轮时间窗 · 各源结果(✅正常/⚠️疑点/⏭️跳过+原因) · 本轮新建/评论/复现的 issue(#+标题) · 进报告但未发 issue 的疑点(供你判断) · 受限或跳过的源。

# 10. 边界（防 rabbit-hole）
- 每源抓快照扫一遍,不翻代码库做审计;log 明确指向某文件才去 confirm 一眼。
- 单个疑点最多交叉 2 个源验证,仍不确定 → 进报告不发 issue（对齐 CLAUDE.md「最多 2 轮」）。
- monitor 只看运行时信号,不为一个疑点无限深挖。

# 11. 调度（外部驱动,本任务不自调度）
本任务由外部按固定间隔触发——会话内 `/loop <间隔>`（如 `/loop 4h …`,interval 模式由 harness 用 cron 驱动）,或 launchd/cron + `claude -p`。**本轮巡检结束即停,不要自己调用 ScheduleWakeup、不要自排下一轮**:间隔由外部控制,自调度会和它打架,且 ScheduleWakeup 上限 1h 也撑不到 4h。
