"""PipelineService(方案 1)：OAuth 安装 + 出 plan → 等确认 → 委派 Codex + 反复改。"""

from __future__ import annotations

from typing import Any

import pytest

import dev_pipeline.service as service_mod
from dev_pipeline.config import Settings
from dev_pipeline.linear.client import LinearClient
from dev_pipeline.linear.models import PipelineTrigger, TriggerKind
from dev_pipeline.planner import Plan
from dev_pipeline.service import APP_TOKEN_KEY, PipelineService
from dev_pipeline.store import Store


class FakeLinear(LinearClient):
    def __init__(self, api_key: str = "x", api_url: str = "u") -> None:
        super().__init__(api_key=api_key)
        self.comments: list[tuple[str, str]] = []
        self.activities: list[tuple[str, str, str]] = []
        self.delegates: list[tuple[str, str]] = []
        self.pr_attachments: list[dict[str, str]] = []  # issue 上挂的 PR 链接

    async def _execute(
        self, query: str, variables: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        v = (variables or {}).get("input", {})
        if "attachments" in query:
            return {"issue": {"attachments": {"nodes": self.pr_attachments}}}
        if "commentCreate" in query:
            self.comments.append((v.get("issueId", ""), v.get("body", "")))
            return {"commentCreate": {"success": True, "comment": {"id": "c"}}}
        if "agentActivityCreate" in query:
            self.activities.append(
                (v.get("agentSessionId", ""), v.get("content", {}).get("type", ""),
                 v.get("content", {}).get("body", ""))
            )
            return {"agentActivityCreate": {"success": True, "agentActivity": {"id": "a"}}}
        if "issueUpdate" in query:
            self.delegates.append(((variables or {}).get("id", ""), v.get("delegateId", "")))
            return {"issueUpdate": {"success": True}}
        return {}


class FakePlanner:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def make_plan(self, title: str, description: str) -> Plan:
        self.calls.append((title, description))
        return Plan(summary=f"方案 for {title}", todos=["改 A", "改 B"], files=["x.tsx"])


def _service(
    monkeypatch: pytest.MonkeyPatch, *, installed: bool, planner: FakePlanner | None = None
) -> tuple[PipelineService, FakeLinear]:
    fake = FakeLinear()
    monkeypatch.setattr(service_mod, "LinearClient", lambda token, url: fake)
    store = Store(":memory:")
    if installed:
        store.set_secret(APP_TOKEN_KEY, "app_tok")
    settings = Settings(linear_oauth_client_id="cid", codex_linear_assignee_id="user_codex")
    svc = PipelineService(settings, store, planner=planner)
    return svc, fake


def _created() -> PipelineTrigger:
    return PipelineTrigger(
        kind=TriggerKind.AGENT_SESSION_CREATED, issue_id="i1", issue_identifier="EDG-1",
        issue_title="加一个刷新按钮", issue_description="在 Now 页加刷新", agent_session_id="ags1",
        prompt="fix it",
    )


def _prompted(text: str) -> PipelineTrigger:
    return PipelineTrigger(
        kind=TriggerKind.AGENT_SESSION_PROMPTED, issue_id="i1", agent_session_id="ags1",
        issue_title="加一个刷新按钮", prompt=text,
    )


@pytest.mark.asyncio
async def test_created_plans_and_asks_not_delegates(monkeypatch: pytest.MonkeyPatch) -> None:
    # 核心：created 时出 plan + 问确认，**不**直接 @Codex
    planner = FakePlanner()
    svc, fake = _service(monkeypatch, installed=True, planner=planner)
    await svc.handle(_created())
    assert planner.calls == [("加一个刷新按钮", "在 Now 页加刷新")]
    # 贴了 plan（elicitation），没有 @Codex 评论
    assert any(a[1] == "elicitation" and "方案" in a[2] for a in fake.activities)
    assert fake.comments == []


@pytest.mark.asyncio
async def test_created_without_planner_degrades_to_delegate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 没配 ANTHROPIC_API_KEY → 退化为直接委派，保证不卡死
    svc, fake = _service(monkeypatch, installed=True, planner=None)
    await svc.handle(_created())
    assert fake.comments and "fix it" in fake.comments[0][1]
    assert fake.delegates == [("i1", "user_codex")]  # delegate 给 Codex 才真触发


@pytest.mark.asyncio
async def test_confirm_delegates_plan_to_codex(monkeypatch: pytest.MonkeyPatch) -> None:
    planner = FakePlanner()
    svc, fake = _service(monkeypatch, installed=True, planner=planner)
    await svc.handle(_created())          # 出 plan，等确认
    fake.comments.clear()
    await svc.handle(_prompted("ok"))     # 确认
    # 把 plan（含 to-do）当 spec 委派给 Codex：贴评论 + delegate
    assert len(fake.comments) == 1
    issue, body = fake.comments[0]
    assert issue == "i1" and "改 A" in body
    assert fake.delegates == [("i1", "user_codex")]


@pytest.mark.asyncio
async def test_non_affirmative_replans(monkeypatch: pytest.MonkeyPatch) -> None:
    planner = FakePlanner()
    svc, fake = _service(monkeypatch, installed=True, planner=planner)
    await svc.handle(_created())
    await svc.handle(_prompted("不对，换个做法"))
    # 重新出了 plan（planner 被调两次），没委派 Codex
    assert len(planner.calls) == 2
    assert fake.comments == []


@pytest.mark.asyncio
async def test_followup_after_delegate_forwards_to_codex(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    planner = FakePlanner()
    svc, fake = _service(monkeypatch, installed=True, planner=planner)
    await svc.handle(_created())
    await svc.handle(_prompted("ok"))     # 确认 → 委派，清 awaiting
    fake.comments.clear()
    await svc.handle(_prompted("按钮放右上角"))  # 已委派后的反复改
    assert fake.comments and "按钮放右上角" in fake.comments[0][1]


class _RecordingGitHub:
    """记录 gh 子进程调用。区分 `gh pr view`（get_pr→单对象）与 `gh pr list`（搜索→列表，
    可配空表模拟搜不到），workflow run 记下被触发的 PR 号。CI 状态可配。"""

    def __init__(self, ci: str = "SUCCESS", *, list_finds_pr: bool = True) -> None:
        self.runs: list[tuple[str, str]] = []  # (workflow 文件名, "pr=N")
        self._ci = ci
        self._list_finds = list_finds_pr
        from dev_pipeline.github.client import GitHubClient
        self._client = GitHubClient("r", runner=self._run)

    @property
    def triggered(self) -> list[str]:
        """只触发了 preview.yml 的 pr 参数（部署测试的便捷断言）。"""
        return [pr for wf, pr in self.runs if wf == "preview.yml"]

    def _pr(self) -> dict[str, Any]:
        return {"number": 7, "url": "https://github.com/x/y/pull/7",
                "headRefName": "dev-pipeline/EDG-5", "state": "OPEN",
                "statusCheckRollup": [{"conclusion": self._ci}]}

    def _run(self, args: Any) -> str:
        import json
        a = list(args)
        if a[:3] == ["gh", "workflow", "run"]:
            self.runs.append((a[3], a[-1]))  # (workflow, "pr=7")
            return ""
        if a[:3] == ["gh", "pr", "view"]:       # get_pr → 单对象
            return json.dumps(self._pr())
        if a[:3] == ["gh", "pr", "list"]:       # find_pr_for_issue → 列表（可空）
            return json.dumps([self._pr()] if self._list_finds else [])
        return ""


def _deploy_svc(
    monkeypatch: pytest.MonkeyPatch, gh: _RecordingGitHub
) -> tuple[PipelineService, FakeLinear]:
    fake = FakeLinear()
    monkeypatch.setattr(service_mod, "LinearClient", lambda token, url: fake)
    store = Store(":memory:")
    store.set_secret(APP_TOKEN_KEY, "app_tok")
    svc = PipelineService(Settings(linear_oauth_client_id="cid"), store, github=gh._client)
    return svc, fake


@pytest.mark.asyncio
async def test_deploy_intent_triggers_fly_preview(monkeypatch: pytest.MonkeyPatch) -> None:
    # 在已有 session 里回复"部署"→ 找绿 PR → 触发 Fly preview workflow → 回贴确定的 URL
    gh = _RecordingGitHub()
    svc, fake = _deploy_svc(monkeypatch, gh)
    await svc.handle(PipelineTrigger(
        kind=TriggerKind.AGENT_SESSION_PROMPTED, issue_id="i1", issue_identifier="EDG-5",
        agent_session_id="ags1", prompt="部署看看效果",
    ))
    assert gh.triggered == ["pr=7"]
    assert any("pinai-pr-7.fly.dev" in body for _, body in fake.comments)


@pytest.mark.asyncio
async def test_deploy_intent_on_created_previews_not_plans(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 新 @ 一个 session 就说"preview"也要起 preview，不能误当成新需求去出 plan
    gh = _RecordingGitHub()
    svc, fake = _deploy_svc(monkeypatch, gh)
    # planner 若被调用会抛错 —— 证明部署意图没走 _plan_and_ask
    svc._planner_override = _BoomPlanner()
    await svc.handle(PipelineTrigger(
        kind=TriggerKind.AGENT_SESSION_CREATED, issue_id="i1", issue_identifier="EDG-5",
        issue_title="某需求", agent_session_id="ags1", prompt="preview",
    ))
    assert gh.triggered == ["pr=7"]


@pytest.mark.asyncio
async def test_preview_deploys_even_when_ci_pending(monkeypatch: pytest.MonkeyPatch) -> None:
    # CI 没绿也照起 preview（只在回贴里标注），不拦
    gh = _RecordingGitHub(ci="")  # 空 conclusion → CIStatus.PENDING
    svc, fake = _deploy_svc(monkeypatch, gh)
    await svc.handle(PipelineTrigger(
        kind=TriggerKind.AGENT_SESSION_PROMPTED, issue_id="i1", issue_identifier="EDG-5",
        agent_session_id="ags1", prompt="部署",
    ))
    assert gh.triggered == ["pr=7"]
    assert any("pinai-pr-7.fly.dev" in body and "CI 还在跑" in body for _, body in fake.comments)


@pytest.mark.asyncio
async def test_teardown_intent_triggers_preview_down(monkeypatch: pytest.MonkeyPatch) -> None:
    # 说「拆 preview / 关掉」→ 触发 preview-down workflow，不去出 plan、不误触发部署
    gh = _RecordingGitHub()
    svc, fake = _deploy_svc(monkeypatch, gh)
    await svc.handle(PipelineTrigger(
        kind=TriggerKind.AGENT_SESSION_PROMPTED, issue_id="i1", issue_identifier="EDG-5",
        agent_session_id="ags1", prompt="拆 preview",
    ))
    assert gh.runs == [("preview-down.yml", "pr=7")]  # 只触发了拆，没触发部署


@pytest.mark.asyncio
async def test_preview_finds_pr_via_linear_attachment(monkeypatch: pytest.MonkeyPatch) -> None:
    # GitHub 文本搜不到（PR 标题不含 issue 标识），靠 Linear issue 上挂的 PR 链接找到
    gh = _RecordingGitHub(list_finds_pr=False)  # gh pr list 搜返回空
    svc, fake = _deploy_svc(monkeypatch, gh)
    fake.pr_attachments = [{"url": "https://github.com/x/y/pull/7"}]
    await svc.handle(PipelineTrigger(
        kind=TriggerKind.AGENT_SESSION_PROMPTED, issue_id="i1", issue_identifier="EDG-5",
        agent_session_id="ags1", prompt="部署",
    ))
    assert gh.triggered == ["pr=7"]


@pytest.mark.asyncio
async def test_401_remints_token_and_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    # token 失效 → 服务用 client_credentials 自动重 mint + 重试，无需人工授权/revoke
    from dev_pipeline.linear.client import LinearError

    mints: list[int] = []

    async def fake_mint(self: object, scopes: object = None) -> str:
        mints.append(1)
        return f"tok{len(mints)}"

    monkeypatch.setattr("dev_pipeline.linear.oauth.LinearOAuth.mint_app_token", fake_mint)

    class FlakyLinear(FakeLinear):
        _first = True

        async def _execute(
            self, query: str, variables: dict[str, Any] | None = None
        ) -> dict[str, Any]:
            if "agentActivityCreate" in query and self._first:
                self._first = False
                raise LinearError("Authentication required, not authenticated")
            return await super()._execute(query, variables)

    fake = FlakyLinear()
    monkeypatch.setattr(service_mod, "LinearClient", lambda token, url: fake)
    store = Store(":memory:")  # 无存量 token → 触发 mint
    settings = Settings(linear_oauth_client_id="cid", linear_oauth_client_secret="sec")
    svc = PipelineService(settings, store, planner=FakePlanner())
    await svc.handle(_created())
    assert len(mints) >= 1  # mint 过（初次 + 401 重试）
    assert any(a[1] == "elicitation" for a in fake.activities)  # 重试后 plan 正常贴出


class _FakeRouter:
    """固定返回某个意图，验证 _run_intent 路由对不对。"""

    def __init__(self, intent: str, reply: str = "") -> None:
        from dev_pipeline.intent import IntentResult
        self._r = IntentResult(intent=intent, reply=reply)
        self.seen: list[tuple[str, Any]] = []

    def route(self, message: str, ctx: Any) -> Any:
        self.seen.append((message, ctx))
        return self._r


@pytest.mark.asyncio
async def test_ai_router_deploy_without_keyword(monkeypatch: pytest.MonkeyPatch) -> None:
    # AI 判成 deploy（句子里没有"部署/preview"字样）→ 照样起 preview
    gh = _RecordingGitHub()
    svc, fake = _deploy_svc(monkeypatch, gh)
    svc._router_override = _FakeRouter("deploy")
    await svc.handle(PipelineTrigger(
        kind=TriggerKind.AGENT_SESSION_PROMPTED, issue_id="i1", issue_identifier="EDG-5",
        agent_session_id="ags1", prompt="上线瞅一眼效果",
    ))
    assert gh.triggered == ["pr=7"]


@pytest.mark.asyncio
async def test_ai_router_clarify_asks_back(monkeypatch: pytest.MonkeyPatch) -> None:
    # 模棱两可 → clarify → 反问，不瞎执行（不部署、不委派）
    gh = _RecordingGitHub()
    svc, fake = _deploy_svc(monkeypatch, gh)
    svc._router_override = _FakeRouter("clarify", reply="你是想起 preview 还是改方案？")
    await svc.handle(_prompted("那个东西"))
    assert any(a[1] == "elicitation" and "preview" in a[2] for a in fake.activities)
    assert gh.runs == [] and fake.comments == []  # 没瞎部署/委派


@pytest.mark.asyncio
async def test_ai_router_confirm_delegates(monkeypatch: pytest.MonkeyPatch) -> None:
    # AI 判成 confirm → 把存的 plan 当 spec 委派 Codex
    planner = FakePlanner()
    svc, fake = _service(monkeypatch, installed=True, planner=planner)
    svc._router_override = _FakeRouter("new_request")
    await svc.handle(_created())  # 先出 plan，落库 awaiting + plan
    fake.comments.clear()
    svc._router_override = _FakeRouter("confirm")
    await svc.handle(_prompted("嗯就这么干"))
    assert fake.delegates == [("i1", "user_codex")]
    assert any("改 A" in body for _, body in fake.comments)  # plan 当 spec


class _BoomPlanner:
    def make_plan(self, title: str, description: str) -> Plan:
        raise AssertionError("planner 不该被调用：部署意图应直接走 preview")


@pytest.mark.asyncio
async def test_noop_when_not_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    svc, fake = _service(monkeypatch, installed=False, planner=FakePlanner())
    await svc.handle(_created())
    assert fake.comments == [] and fake.activities == []


@pytest.mark.asyncio
async def test_complete_oauth_stores_token(monkeypatch: pytest.MonkeyPatch) -> None:
    store = Store(":memory:")

    async def fake_exchange(self: object, code: str) -> str:
        return "tok_from_code"

    monkeypatch.setattr("dev_pipeline.linear.oauth.LinearOAuth.exchange_code", fake_exchange)
    svc = PipelineService(Settings(linear_oauth_client_id="cid"), store)
    url = svc.authorize_url()
    state = url.split("state=")[1].split("&")[0]
    await svc.complete_oauth("code123", state)
    assert store.get_secret(APP_TOKEN_KEY) == "tok_from_code"
    assert svc.is_installed() is True
