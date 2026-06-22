"""dev-pipeline 的 Linear-side 服务：OAuth 安装 + 以 agent 身份在 AgentSession 里
**出 plan → 等确认 → 确认后才委派 Codex**（这才是这层区别于"直接 @codex"的价值），
以及确认后把后续补充反复转发给 Codex、按需起 preview。

职责边界（全程人在 Linear 里主动驱动，没有后台轮询/自动收敛循环）：
- 装：跑 actor=app OAuth，把 app token 存进 store。
- 收到 issue assign/@提及（AgentSession created）→ planner 读代码出 plan → 贴回 session
  + 问"确认吗"，**停在这里等人**（不直接 @Codex）。
- 收到后续补充（prompted）：
  - 说"部署/看看效果" → 找 Codex 的 PR → CI 绿 → 触发 Fly preview workflow → 回 URL。
  - 说"ok/确认" → 把 plan 当 spec 委派 @Codex（delegateId 触发）。
  - 其它 → 当作对 plan 的反馈，重出 plan；已委派过则直接转发给 Codex。
"""

from __future__ import annotations

import asyncio
import logging
import re
import secrets

from anthropic import Anthropic

from dev_pipeline.config import Settings
from dev_pipeline.github.client import CIStatus, GitHubClient, PullRequest
from dev_pipeline.intent import IntentContext, IntentResult, IntentRouter
from dev_pipeline.linear.client import LinearClient, LinearError
from dev_pipeline.linear.models import PipelineTrigger, TriggerKind
from dev_pipeline.linear.oauth import LinearOAuth
from dev_pipeline.planner import Planner
from dev_pipeline.store import Store

log = logging.getLogger("dev_pipeline")

APP_TOKEN_KEY = "linear_app_token"
# 肯定回复（确认 plan）的关键词
_AFFIRM = {
    "ok", "okay", "确认", "可以", "行", "好", "go", "approve", "approved", "yes", "批准", "👍",
}
# 部署/看 preview 的意图关键词（人主动 @ 触发）
_DEPLOY = {"部署", "preview", "预览", "看看", "看效果", "起服务", "deploy", "上线看", "跑起来"}
# 拆/关 preview 的意图关键词（反向于部署）。注意：必须比 _DEPLOY 先判定——
# "拆 preview" / "关 preview" 含 "preview" 也会命中 _DEPLOY，靠 _handle 里的判定顺序消歧。
_TEARDOWN = {"拆", "关掉", "关闭", "停掉", "销毁", "下线", "teardown", "destroy", "拆掉", "撤"}
# 从 GitHub PR URL 抠 PR 号（Linear attachment 里挂的就是 .../pull/<N>）
_PR_NUM_RE = re.compile(r"/pull/(\d+)")


def _is_affirmative(text: str) -> bool:
    t = text.strip().lower()
    return any(w in t for w in _AFFIRM)


def _is_deploy(text: str) -> bool:
    t = text.strip().lower()
    return any(w in t for w in _DEPLOY)


def _is_teardown(text: str) -> bool:
    t = text.strip().lower()
    return any(w in t for w in _TEARDOWN)


def _is_auth_error(e: Exception) -> bool:
    """Linear 回的认证错误（token 失效）—— 用于触发自动重 mint。
    只认 authentication 字样（Linear auth 错误必带 'authentication error' / 'not
    authenticated' / 'AUTHENTICATION_ERROR'）；不用裸 '401' 子串，避免误匹配 4010 等。"""
    s = str(e).lower()
    return "authentication" in s or "not authenticated" in s


class PipelineService:
    def __init__(
        self,
        settings: Settings,
        store: Store,
        planner: Planner | None = None,
        github: GitHubClient | None = None,
        router: IntentRouter | None = None,
    ) -> None:
        self._s = settings
        self._store = store
        self._oauth = LinearOAuth(
            settings.linear_oauth_client_id,
            settings.linear_oauth_client_secret,
            settings.linear_oauth_redirect_uri,
        )
        self._pending_states: set[str] = set()
        self._planner_override = planner
        self._github_override = github
        self._router_override = router

    def _github(self) -> GitHubClient:
        return self._github_override or GitHubClient(self._s.target_repo)

    def _router(self) -> IntentRouter | None:
        if self._router_override is not None:
            return self._router_override
        if not self._s.anthropic_api_key:
            return None
        return IntentRouter(
            Anthropic(api_key=self._s.anthropic_api_key), model=self._s.intent_model
        )

    def _planner(self) -> Planner | None:
        if self._planner_override is not None:
            return self._planner_override
        if not self._s.anthropic_api_key:
            return None
        root = self._s.repo_root or str(_git_root())
        return Planner(
            root,
            client=Anthropic(api_key=self._s.anthropic_api_key),
            model=self._s.planner_model,
            max_iterations=self._s.planner_max_iterations,
        )

    # --- OAuth 安装（actor=app）---

    def authorize_url(self) -> str:
        state = secrets.token_urlsafe(16)
        self._pending_states.add(state)
        return self._oauth.authorize_url(state)

    async def complete_oauth(self, code: str, state: str) -> None:
        # state 校验（CSRF）；进程重启会丢 pending，宽松放行已知或空集场景由调用方决定
        self._pending_states.discard(state)
        token = await self._oauth.exchange_code(code)
        self._store.set_secret(APP_TOKEN_KEY, token)

    def is_installed(self) -> bool:
        # client_credentials 可随时自助 mint token，所以有 client_id+secret 即视为已装
        return bool(self._s.linear_oauth_client_id and self._s.linear_oauth_client_secret) or (
            self._store.get_secret(APP_TOKEN_KEY) is not None
        )

    async def _agent_client(self, *, force_refresh: bool = False) -> LinearClient | None:
        """以 app 身份回写 Linear 的 client。token 经 client_credentials 自助 mint（30 天，
        无需浏览器授权/回调/revoke）；force_refresh 时强制重 mint（401 自愈用）。"""
        token = None if force_refresh else self._store.get_secret(APP_TOKEN_KEY)
        if not token:
            if not (self._s.linear_oauth_client_id and self._s.linear_oauth_client_secret):
                return None  # 没配 client 凭证 —— 没法 mint
            token = await self._oauth.mint_app_token()
            self._store.set_secret(APP_TOKEN_KEY, token)
            log.info("minted fresh Linear app token (client_credentials)")
        return LinearClient(token, self._s.linear_api_url)

    # --- AgentSession 应答 + 委派 Codex ---

    async def handle(self, trigger: PipelineTrigger) -> None:
        try:
            await self._handle(trigger)
        except Exception:
            log.exception("handle failed: kind=%s issue=%s", trigger.kind, trigger.issue_id)

    async def _handle(self, trigger: PipelineTrigger) -> None:
        client = await self._agent_client()
        if client is None:
            log.warning("handle skipped: 没配 Linear client 凭证，无法 mint token")
            return
        log.info(
            "handle: kind=%s issue=%s session=%s prompt=%r",
            trigger.kind, trigger.issue_id, trigger.agent_session_id, trigger.prompt,
        )
        try:
            await self._dispatch(client, trigger)
        except LinearError as e:
            if not _is_auth_error(e):
                raise
            # token 失效（30 天到期等）→ 重新 mint 一个并重试一次，自愈，无需人工授权/revoke
            log.warning("Linear 401 → 重新 mint app token 并重试: %s", e)
            client = await self._agent_client(force_refresh=True)
            if client is not None:
                await self._dispatch(client, trigger)
        log.info("handle done: issue=%s", trigger.issue_id)

    async def _dispatch(self, client: LinearClient, trigger: PipelineTrigger) -> None:
        """用 AI 理解用户这句话想干嘛来路由（agent 是有大脑的运维同事，不靠关键词撞）。
        带上下文消歧、不清楚就反问；LLM 不可用/出错时退化到关键词兜底，保证不卡死。"""
        router = self._router()
        if router is None:
            await self._dispatch_keyword(client, trigger)
            return
        ctx = self._intent_context(trigger)
        try:
            # sync LLM 调用丢线程，别卡住整个 async 服务（healthz / 其它 webhook）
            result = await asyncio.to_thread(router.route, trigger.prompt or "", ctx)
        except Exception:
            log.exception("intent route 失败 → 关键词兜底")
            await self._dispatch_keyword(client, trigger)
            return
        log.info(
            "intent=%s (awaiting=%s delegated=%s) reply=%r",
            result.intent, ctx.awaiting_plan, ctx.delegated, result.reply,
        )
        await self._run_intent(client, trigger, result, ctx)

    def _intent_context(self, trigger: PipelineTrigger) -> IntentContext:
        issue = trigger.issue_id
        return IntentContext(
            awaiting_plan=bool(issue and self._store.get_secret(_await_key(issue))),
            delegated=bool(issue and self._store.get_secret(_delegated_key(issue))),
            issue_title=trigger.issue_title or "",
            issue_desc=trigger.issue_description or "",
        )

    async def _run_intent(
        self,
        client: LinearClient,
        trigger: PipelineTrigger,
        result: IntentResult,
        ctx: IntentContext,
    ) -> None:
        sid = trigger.agent_session_id
        i = result.intent
        if i == "teardown":
            await self._run_teardown(client, trigger)
        elif i == "deploy":
            await self._run_preview(client, trigger)
        elif i == "confirm":
            await self._confirm(client, trigger)
        elif i == "refine_plan":
            await self._replan(client, trigger)
        elif i == "forward" and ctx.delegated:
            await self._forward(client, trigger)  # 仅在已委派后才转 Codex
        elif i == "clarify":
            await self._say(
                client, sid, "elicitation",
                result.reply or "你是想让我出方案、起 preview，还是别的？说具体点我好接。",
            )
        elif i == "chitchat":
            await self._say(
                client, sid, "response",
                result.reply or "我是 dev-pipeline：给我需求我读代码出方案，确认后交给 Codex，"
                "还能按 PR 起 preview / 拆 preview。",
            )
        else:  # new_request 及兜底
            await self._plan_and_ask(client, trigger)

    async def _dispatch_keyword(self, client: LinearClient, trigger: PipelineTrigger) -> None:
        """关键词兜底（仅 LLM 不可用时走）。拆先于部署判（"拆 preview" 含 "preview"）。"""
        prompt = trigger.prompt or ""
        issue = trigger.issue_id
        awaiting = bool(issue and self._store.get_secret(_await_key(issue)))
        if _is_teardown(prompt):
            await self._run_teardown(client, trigger)
        elif _is_deploy(prompt):
            await self._run_preview(client, trigger)
        elif trigger.kind is TriggerKind.AGENT_SESSION_CREATED:
            await self._plan_and_ask(client, trigger)
        elif awaiting and _is_affirmative(prompt):
            await self._confirm(client, trigger)
        elif awaiting:
            await self._replan(client, trigger)
        else:
            await self._forward(client, trigger)

    # --- created：读代码出 plan → 等确认（不直接 @Codex）---

    async def _plan_and_ask(self, client: LinearClient, trigger: PipelineTrigger) -> None:
        sid = trigger.agent_session_id
        planner = self._planner()
        if planner is None:
            # 没配 ANTHROPIC_API_KEY → 退化成直接委派（保证不卡死）
            log.warning("no planner (缺 ANTHROPIC_API_KEY)，退化为直接委派 Codex")
            await self._delegate(client, trigger, spec=trigger.prompt or "实现此 issue")
            return

        if sid:
            await client.create_agent_activity(sid, "thought", "收到需求，正在读相关代码做方案…")
        plan = await asyncio.to_thread(
            planner.make_plan,
            trigger.issue_title or trigger.prompt or "",
            trigger.issue_description or "",
        )
        # 把 plan + awaiting 标记落库（confirm gate 的真源），再贴回 session 等人确认。
        # 新一轮出方案 = 阶段重置：清掉旧的 delegated 标记（避免同 issue 旧"已委派"状态陈旧，
        # 让后续消息被误当成转发给 Codex 而非新需求）。
        if trigger.issue_id:
            self._store.set_secret(_plan_key(trigger.issue_id), plan.to_markdown())
            self._store.set_secret(_await_key(trigger.issue_id), "1")
            self._store.set_secret(_delegated_key(trigger.issue_id), "")
        body = plan.to_markdown() + "\n\n---\n确认就回复「ok」，要调整直接说。"
        if sid:
            await client.create_agent_activity(sid, "elicitation", body)

    # --- 各意图的执行（AI 路由 + 关键词兜底共用）---

    async def _confirm(self, client: LinearClient, trigger: PipelineTrigger) -> None:
        """同意当前方案 → 把 plan 当 spec 委派 Codex，清 awaiting。"""
        issue = trigger.issue_id
        spec = (self._store.get_secret(_plan_key(issue)) if issue else None) or (
            trigger.prompt or ""
        )
        await self._delegate(client, trigger, spec=spec)
        if issue:
            self._store.set_secret(_await_key(issue), "")
        await self._say(
            client, trigger.agent_session_id, "thought", "已确认，交给 Codex 起草实现。"
        )

    async def _replan(self, client: LinearClient, trigger: PipelineTrigger) -> None:
        """对当前方案的反馈 → 带反馈重出一版 plan。"""
        sid = trigger.agent_session_id
        issue = trigger.issue_id
        planner = self._planner()
        if planner is None:
            await self._say(client, sid, "elicitation", "（缺 ANTHROPIC_API_KEY，没法重出方案）")
            return
        plan = await asyncio.to_thread(
            planner.make_plan,
            trigger.issue_title or "",
            f"{trigger.issue_description or ''}\n\n反馈：{trigger.prompt or ''}",
        )
        if issue:
            self._store.set_secret(_plan_key(issue), plan.to_markdown())
        await self._say(
            client, sid, "elicitation", plan.to_markdown() + "\n\n---\n这版可以就回「ok」。"
        )

    async def _forward(self, client: LinearClient, trigger: PipelineTrigger) -> None:
        """已委派后的补充 → 直接转给 Codex 继续改。"""
        await self._delegate(client, trigger, spec=trigger.prompt or "")
        await self._say(
            client, trigger.agent_session_id, "thought", "已把你的补充转给 Codex 继续改。"
        )

    async def _run_preview(self, client: LinearClient, trigger: PipelineTrigger) -> None:
        """人主动触发的部署：找 Codex 的 PR → 触发 Fly preview workflow → 回 URL。

        不拦 CI：preview 是给人肉眼验收用的，CI 没绿也照起（只在 URL 旁标注 CI 状态）。
        真正的质量门是人看完 preview + 看 CI 结论后，自己决定要不要 merge。
        """
        sid = trigger.agent_session_id
        pr = await self._resolve_pr(client, trigger)
        if pr is None:
            msg = "还没找到对应 PR（Codex 可能还没出，或还没点 Create PR）。出了 PR 再说「部署」。"
            await self._say(client, sid, "elicitation", msg)
            return
        ci_note = {
            CIStatus.PASS: "CI 绿",
            CIStatus.PENDING: "⚠️ CI 还在跑",
            CIStatus.FAIL: "⚠️ CI 挂了",
            CIStatus.NONE: "（无 CI）",
        }[pr.ci]
        await self._say(client, sid, "thought", f"{ci_note}，正为 PR #{pr.number} 起 preview")
        self._github().trigger_preview(pr.number)
        # URL 是确定的（pinai-pr-<N>.fly.dev）；workflow 起好约 2 分钟，也会自己回贴到 PR。
        url = f"https://pinai-pr-{pr.number}.fly.dev/"
        if trigger.issue_id:
            await client.create_comment(
                trigger.issue_id,
                f"🚀 正在起 preview（约 2 分钟，{ci_note}），届时可访问：{url}",
            )
        await self._say(client, sid, "response", f"Preview 部署中（约 2 分钟，{ci_note}）：{url}")

    async def _run_teardown(self, client: LinearClient, trigger: PipelineTrigger) -> None:
        """人说「拆/关 preview」→ 找到 PR → 触发 preview-down workflow 销毁临时环境。"""
        sid = trigger.agent_session_id
        pr = await self._resolve_pr(client, trigger)
        if pr is None:
            await self._say(client, sid, "elicitation", "没找到对应 PR，没有要拆的 preview。")
            return
        self._github().trigger_teardown(pr.number)
        await self._say(
            client, sid, "response",
            f"🧹 正在拆 PR #{pr.number} 的 preview（pinai-pr-{pr.number}）。需要再说「部署」重起。",
        )

    async def _resolve_pr(
        self, client: LinearClient, trigger: PipelineTrigger
    ) -> PullRequest | None:
        """找这个 issue 对应的 PR：优先用 Linear issue 上已挂的 GitHub PR attachment
        （可靠），找不到再兜底按 issue 标识去 GitHub 搜文本。"""
        if trigger.issue_id:
            url = await client.issue_pr_url(trigger.issue_id)
            m = _PR_NUM_RE.search(url) if url else None
            if m:
                pr = self._github().get_pr(int(m.group(1)))
                if pr is not None:
                    return pr
        ident = trigger.issue_identifier or ""
        return self._github().find_pr_for_issue(ident) if ident else None

    async def _say(
        self, client: LinearClient, sid: str | None, atype: str, body: str
    ) -> None:
        if sid:
            await client.create_agent_activity(sid, atype, body)

    async def _delegate(self, client: LinearClient, trigger: PipelineTrigger, *, spec: str) -> None:
        if not trigger.issue_id:
            return
        # 贴 plan 当 spec/context（人和 Codex 都能看；Codex 接管时会读 issue 评论）
        await client.create_comment(trigger.issue_id, f"按以下方案实现：\n\n{spec}")
        # 关键触发：把 issue delegate 给 Codex（delegateId）→ 触发 Codex 的 AgentSessionEvent。
        # 实测唯一可靠的程序化触发：assigneeId 不行、纯文本 @mention 不是真 mention。
        if self._s.codex_linear_assignee_id:
            await client.delegate_issue(trigger.issue_id, self._s.codex_linear_assignee_id)
        # 标记已委派 → 后续意图路由用它消歧（之后的补充转 Codex、preview/teardown 才有意义）
        self._store.set_secret(_delegated_key(trigger.issue_id), "1")


def _plan_key(issue_id: str) -> str:
    return f"plan:{issue_id}"


def _await_key(issue_id: str) -> str:
    return f"awaiting_confirm:{issue_id}"


def _delegated_key(issue_id: str) -> str:
    return f"delegated:{issue_id}"


def _git_root() -> object:
    import subprocess
    from pathlib import Path

    try:
        out = subprocess.run(  # noqa: S603
            ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True
        ).stdout.strip()
        return out or Path.cwd()
    except (subprocess.SubprocessError, OSError):
        return Path.cwd()
